// BigModel 标准模型 API 客户端（docs/DECISIONS.md D-001）。
// 本模块不依赖 electron（fetch/AbortSignal 来自 Node），可离线注入 fetchFn 做冒烟测试。
// 错误分类面向"测试连接"明确报因：鉴权失败 / 余额不足 / 模型不可用 / 限流 / 超时 / 网络错误；
// 不自动切换模型或计费接口，不自动重试（重试由用户显式触发）。
import type { ErrorClass } from '../shared/ipc';
import { findHeldUsage, holdAmountCny, keepHold, refund, reserve, settle, type PriceConfig } from './budget';
import { getSettings } from './settings';
import type { Db } from './db';
import {
  BIGMODEL_CHAT_URL,
  BIGMODEL_MODEL,
  MAX_OUTPUT_TOKENS,
  REQUEST_TIMEOUT_MS,
} from '../shared/config';

export type FetchFn = typeof fetch;

export interface BmDeps {
  apiKey: string;
  fetchFn?: FetchFn;
  chatUrl?: string;
  model?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamResult {
  content: string;
  usage: BmUsage | null;
}

export class BigModelError extends Error {
  constructor(
    public readonly errorClass: ErrorClass,
    message: string,
    public readonly raw?: string,
    /** 截断流中已收到的部分内容（结果不明：保留文本与预占，但不得标为完整回复） */
    public readonly partial?: string,
  ) {
    super(message);
    this.name = 'BigModelError';
  }
}

export function classifyAbort(err: unknown): BigModelError {
  const e = err as Error;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new BigModelError('timeout', `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），已取消。`);
  }
  if (e instanceof TypeError) {
    return new BigModelError('network', '网络错误：无法连接到 BigModel 接口。');
  }
  return new BigModelError('unknown', `请求失败：${e?.message ?? String(err)}`);
}

/** 按 HTTP 状态与报错内容分类（保守：无法判定时归 unknown 并附原文摘要） */
export function classifyHttpError(status: number, bodyText: string): BigModelError {
  let msg = bodyText.slice(0, 400);
  let code = '';
  try {
    const j = JSON.parse(bodyText) as { error?: { code?: unknown; message?: unknown } };
    msg = typeof j?.error?.message === 'string' ? j.error.message : msg;
    code = String(j?.error?.code ?? '');
  } catch {
    /* 非 JSON 响应体，保留原文 */
  }
  const hint = `${msg} ${code}`;
  if (status === 401 || status === 403) {
    return new BigModelError('auth', '鉴权失败：API Key 无效或无权限。', hint);
  }
  if (status === 404) {
    return new BigModelError('model', '模型不可用：接口路径或模型标识不存在。', hint);
  }
  if (status === 429) {
    if (/余额|欠费|余额不足|balance|arrears|insufficient/i.test(hint)) {
      return new BigModelError('balance', '余额不足：请前往 BigModel 控制台充值后再试。', hint);
    }
    return new BigModelError('rate_limit', '触发限流：请稍后再试。', hint);
  }
  if (status === 400) {
    if (/model/i.test(hint)) {
      return new BigModelError('model', '模型不可用：请求中的模型标识被拒绝。', hint);
    }
    return new BigModelError('bad_request', '请求被拒绝（400）：参数或内容不符合接口要求。', hint);
  }
  if (status >= 500) {
    return new BigModelError('server', 'BigModel 服务端错误，请稍后再试。', hint);
  }
  return new BigModelError('unknown', `请求失败（HTTP ${status}）。`, hint);
}

interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

async function postChat(
  deps: BmDeps,
  body: Record<string, unknown>,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  let res: Response;
  try {
    res = await fetchFn(deps.chatUrl ?? BIGMODEL_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    } satisfies RequestInitLike);
  } catch (err) {
    throw classifyAbort(err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw classifyHttpError(res.status, text);
  }
  return res;
}

/** 带预算闸的连接测试（ER-R01 R5）：超预算时零网络调用；成功结算/确定性失败退款/结果不明保留预占 */
export async function testConnectionBudgeted(
  db: Db,
  args: { apiKey: string; fetchFn?: FetchFn; price: PriceConfig; limitCny?: number },
): Promise<{ ok: boolean; message: string; errorClass?: ErrorClass; raw?: string; usage?: BmUsage; elapsedMs: number; detail?: string }> {
  const s = getSettings(db);
  const limitCny = args.limitCny ?? s.budgetMonthlyCny;
  const price = args.price;
  const requestId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slot = reserve(db, { requestId, kind: 'test', estInTokens: 32, maxOutTokens: 32, price, limitCny });
  if (!slot.allowed) {
    return {
      ok: false,
      errorClass: 'budget',
      message: `本月预算超限（约 ${slot.spendCny.toFixed(2)} / ${slot.limitCny.toFixed(2)} 元），测试连接未发起；可在设置中调整预算。`,
      elapsedMs: 0,
      detail: '预算超限，测试连接未发起',
    };
  }
  const result = await testConnection({ apiKey: args.apiKey, fetchFn: args.fetchFn });
  if (result.ok) {
    settle(db, slot.usageId!, result.usage ?? null, 32, 32, price);
  } else if (result.errorClass === 'timeout' || result.errorClass === 'network') {
    const u = findHeldUsage(db, requestId);
    if (u) keepHold(db, u.id);
  } else {
    const u = findHeldUsage(db, requestId);
    if (u) refund(db, u.id);
  }
  return result;
}

/** 连接测试：最小文本请求（D-001），返回分类结果与用量 */
export async function testConnection(
  deps: BmDeps,
): Promise<{ ok: boolean; message: string; errorClass?: ErrorClass; raw?: string; usage?: BmUsage; elapsedMs: number }> {
  const started = Date.now();
  try {
    const res = await postChat(deps, {
      model: deps.model ?? BIGMODEL_MODEL,
      messages: [{ role: 'user', content: '连接测试：收到请只回复两个字母：OK' }],
      max_tokens: 32,
      temperature: 0.1,
      stream: false,
    });
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: BmUsage;
    };
    return {
      ok: true,
      message: `连接成功，模型 ${deps.model ?? BIGMODEL_MODEL} 已响应。`,
      usage: j.usage,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const e = err instanceof BigModelError ? err : classifyAbort(err);
    return { ok: false, message: e.message, errorClass: e.errorClass, raw: e.raw, elapsedMs: Date.now() - started };
  }
}

/**
 * 流式对话：解析 SSE（data: 行），累积 content 增量；usage 通常在最后一个分块。
 * 提交后超时/中断抛 BigModelError('timeout'|'network'|'unknown')，由调用方按"结果不明"处理。
 */
export async function streamChat(
  deps: BmDeps,
  args: {
    messages: ChatMessage[];
    signal?: AbortSignal;
    maxTokens?: number;
    onDelta?: (text: string) => void;
  },
): Promise<StreamResult> {
  const res = await postChat(
    deps,
    {
      model: deps.model ?? BIGMODEL_MODEL,
      messages: args.messages,
      stream: true,
      max_tokens: args.maxTokens ?? MAX_OUTPUT_TOKENS,
    },
    args.signal,
  );
  if (!res.body) {
    throw new BigModelError('unknown', '响应为空。');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: BmUsage | null = null;
  let sawDone = false;
  let finishReason: string | null = null;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) return; // 空行 / 注释心跳
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let chunk: {
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
      usage?: BmUsage;
      error?: { message?: string; code?: unknown };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // 忽略无法解析的分块
    }
    if (chunk.error) {
      throw new BigModelError('server', `接口返回错误：${chunk.error.message ?? '未知'}`, data.slice(0, 300));
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      content += delta;
      args.onDelta?.(delta);
    }
    const fr = chunk.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
    if (chunk.usage) usage = chunk.usage;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer);
  } catch (err) {
    if (err instanceof BigModelError) throw err;
    throw classifyAbort(err);
  }

  // 完成判定（ER-R01 R4）：必须看到 [DONE] 或任一分块的 finish_reason；
  // 正常 EOF 不等于完整成功——截断流抛"结果不明"并携带已收到的部分内容。
  if (!sawDone && !finishReason) {
    throw new BigModelError('unknown', '流式响应中断（未收到完成标记），结果不明。', undefined, content);
  }
  return { content, usage };
}

/** 非流式补全（用于 JSON 提炼，D-011）：完整响应由调用方先保存再校验 */
export async function completeChat(
  deps: BmDeps,
  args: { messages: ChatMessage[]; signal?: AbortSignal; maxTokens?: number },
): Promise<StreamResult> {
  const res = await postChat(
    deps,
    {
      model: deps.model ?? BIGMODEL_MODEL,
      messages: args.messages,
      stream: false,
      max_tokens: args.maxTokens ?? MAX_OUTPUT_TOKENS,
    },
    args.signal,
  );
  const j = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: BmUsage;
  } | null;
  const content = j?.choices?.[0]?.message?.content ?? '';
  if (!content) {
    throw new BigModelError('unknown', '接口返回内容为空。');
  }
  return { content, usage: j?.usage ?? null };
}
