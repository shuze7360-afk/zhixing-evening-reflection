// 会话编排器：晚间复盘状态机（docs/PRODUCT.md §2）。
// 流程：自由讲述 → 最多两个单问题追问 → 简短反馈 → 可选行动 → 结束 → 自动沉淀。
// 纪律：用户消息先落库再请求；提交后超时→"结果不明"，不自动重发；提炼失败保留草稿，不虚报正式日报。
// 本模块不 import electron：通知与路径经 deps 注入，可离线 mock 测试。
import {
  MAX_INPUT_BYTES,
  OUTPUT_ESTIMATE,
  PROMPT_VERSION,
  REQUEST_TIMEOUT_MS,
} from '../shared/config';
import type {
  AppEvent,
  ErrorClass,
  MessageRecord,
  ModelEvent,
  SessionRecord,
  StartChatResult,
  StartShortArgs,
  TodaySnapshot,
} from '../shared/ipc';
import { localDate, parseDailyReportJson, SendContentSchema, StartShortSchema } from '../shared/schemas';
import { BigModelError, completeChat, streamChat, type BmDeps, type BmUsage, type FetchFn } from './bigmodel';
import {
  effectiveSpendCny,
  findHeldUsage,
  keepHold,
  refund,
  reserve,
  settle,
  type PriceConfig,
} from './budget';
import { all, get, newId, nowIso, run, withTransaction, type Db } from './db';
import { fillTemplate, loadPrompt } from './prompts';
import { activeExperiment } from './experiments';
import { enabledPrinciples } from './principles';
import { insertCurrentRevision, insertReport, latestReportByDate, queueReportExport, toExportTaskRecord, toReportRecord } from './reports';
import { getApiKey, getSettings, resolveApiConfig } from './settings';

const MAX_FOLLOWUPS = 2;

export interface SessionDeps {
  db: Db;
  promptsBaseDir: string;          // .../resources
  fetchFn?: FetchFn;               // 测试注入
  appVersion: string;
  cryptor: CryptorLike;            // safeStorage 适配（测试可注入 fake）
  notifyModel(e: ModelEvent): void;
  notifyApp(e: AppEvent): void;
}

export interface CryptorLike {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string | null;
}

export function createSessionService(deps: SessionDeps) {
  const { db } = deps;
  /** 每会话同时只允许一个在途请求 */
  const inflight = new Map<string, AbortController>();

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  const sessionById = (id: string): SessionRecord | undefined => {
    const r = get<DbSession>(db, `SELECT * FROM sessions WHERE id = ?`, id);
    return r ? mapSession(r) : undefined;
  };

  const messagesOf = (sessionId: string): MessageRecord[] =>
    all<DbMessage>(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid`,
      sessionId,
    ).map(mapMessage);

  function snapshotOf(s: SessionRecord | null): TodaySnapshot {
    if (!s) return { session: null, messages: [], latestReport: null, exportTask: null };
    const report = latestReportByDate(db, s.date) ?? null;
    const exportTask = report
      ? toExportTaskRecord(
          all(db, `SELECT * FROM export_tasks WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1`, report.id)[0] ?? null,
        )
      : null;
    return {
      session: s,
      messages: messagesOf(s.id),
      latestReport: report ? toReportRecord(report) : null,
      exportTask,
    };
  }

  function getToday(): TodaySnapshot {
    const date = localDate();
    const row = get<DbSession>(
      db,
      `SELECT * FROM sessions WHERE date = ? ORDER BY started_at DESC LIMIT 1`,
      date,
    );
    return snapshotOf(row ? mapSession(row) : null);
  }

  // ---------------------------------------------------------------------------
  // 开始 / 简短模式
  // ---------------------------------------------------------------------------

  function startChat(): StartChatResult {
    const date = localDate();
    const existing = get<DbSession>(
      db,
      `SELECT * FROM sessions WHERE date = ? AND kind = 'chat' AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      date,
    );
    if (existing) return { ok: true, snapshot: snapshotOf(mapSession(existing)) };
    const id = newId();
    run(
      db,
      `INSERT INTO sessions (id, date, kind, phase, followup_used, status, prompt_version, model, started_at)
       VALUES (?, ?, 'chat', 'narrate', 0, 'active', ?, ?, ?)`,
      id,
      date,
      PROMPT_VERSION,
      resolveApiConfig(db).model,
      nowIso(),
    );
    return { ok: true, snapshot: snapshotOf(sessionById(id)!) };
  }

  function startShort(args: StartShortArgs): { ok: boolean; error?: string; detail?: string; snapshot?: TodaySnapshot } {
    const parsed = StartShortSchema.safeParse(args);
    if (!parsed.success) return { ok: false, error: 'invalid', detail: '内容为空或过长' };
    const date = localDate();
    const id = newId();
    run(
      db,
      `INSERT INTO sessions (id, date, kind, phase, followup_used, status, prompt_version, model, started_at, ended_at)
       VALUES (?, ?, 'short', 'closed', 0, 'closed', ?, NULL, ?, ?)`,
      id,
      date,
      PROMPT_VERSION,
      nowIso(),
      nowIso(),
    );
    run(
      db,
      `INSERT INTO messages (id, session_id, role, kind, content, state, created_at)
       VALUES (?, ?, 'user', 'text', ?, 'verified', ?)`,
      newId(),
      id,
      parsed.data.content,
      nowIso(),
    );
    // R8 同日归并：同日已有正式日报（含此前简短记录）→ 合并进新修订（保留已有内容），旧版 superseded 可查
    // W5：读取最新版、合并、分配 rev、替代旧版在同一事务（重试重新读取合并）
    const mergeResult = withTransaction(db, () => {
    const prev = latestReportByDate(db, date);
    let content;
    if (prev && prev.formal === 1) {
      let prevContent;
      try {
        prevContent = JSON.parse(prev.content_json);
      } catch {
        prevContent = null;
      }
      content = {
        coverage: `简短模式补充：${date} 当天共 ${((prevContent?.experiences ?? []).length ?? 0) + 1} 条一句话记录（含此前复盘）。`,
        experiences: [...(prevContent?.experiences ?? []), parsed.data.content],
        feelings: [
          ...(prevContent?.feelings ?? []),
          ...(parsed.data.mood && !(prevContent?.feelings ?? []).some((f: string) => f.includes(parsed.data.mood!))
            ? [`情绪标记：${parsed.data.mood}`]
            : []),
        ],
        keep_practices: prevContent?.keep_practices ?? [],
        open_questions: prevContent?.open_questions ?? [],
        related_ideas: prevContent?.related_ideas ?? [],
        ai_notes: prevContent?.ai_notes ?? [],
        action_candidates: prevContent?.action_candidates ?? [],
        actions_accepted: prevContent?.actions_accepted ?? [],
        fact_sources: prevContent?.fact_sources ?? [],
        feelings_confirmed: prevContent?.feelings_confirmed ?? [],
      };
    } else {
      content = {
        coverage: `简短模式：${date} 仅一句话记录（未发起模型反馈）。`,
        experiences: [parsed.data.content],
        feelings: parsed.data.mood ? [`情绪标记：${parsed.data.mood}`] : [],
        keep_practices: [],
        open_questions: [],
        related_ideas: [],
        ai_notes: [],
        action_candidates: [],
        actions_accepted: [],
        fact_sources: [],
        feelings_confirmed: [],
      };
    }
    // S10：单事务 + 每日期唯一当前正式版索引
    const report = insertCurrentRevision(db, {
      date,
      sourceSessionId: id,
      content,
      model: prev && prev.formal === 1 ? prev.model : null,
      promptVersion: prev && prev.formal === 1 ? prev.prompt_version : null,
      requestId: null,
      formal: true,
    });
      return { report, date, model: report.model, promptVersion: report.prompt_version };
    });
    const report = mergeResult.report;
    queueReportExport(db, report, deps.appVersion, deps.notifyApp);
    return { ok: true, snapshot: getToday() };
  }

  // ---------------------------------------------------------------------------
  // 对话发送
  // ---------------------------------------------------------------------------

  function buildHistory(sessionId: string): { role: 'user' | 'assistant'; content: string }[] {
    return all<DbMessage>(
      db,
      `SELECT * FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid`,
      sessionId,
    ).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  /** 各阶段追问规则（提示词 {{QUESTION_RULE}}） */
  function questionRule(phase: string, followupUsed = 0): string {
    switch (phase) {
      case 'narrate':
        return '当前是自由讲述轮：反馈结束后，如果你想追问，可以在最后单独一行以【追问】开头提一个问题（只问一个，用于补全今天的细节）。不确定就不问。';
      case 'followup':
        return `当前是追问轮：你已提出过 ${followupUsed} 个追问，上限 ${MAX_FOLLOWUPS} 个；本次是第 ${followupUsed + 1} 个，也是最后一个。用户刚回答了你的追问。如确有必要才再问一个问题，且只问一个；通常这里不必再问。`;
      case 'wrapup':
        return '当前是收束轮：不要再提问。给出收束反馈：今天最值得带走的一件事；可以提示“有想试的改变，结束复盘后可在日报里确认”。';
      case 'deep':
        return '当前是深入探讨轮（用户主动选择）：自由回应，不使用【追问】行，仍遵守全部输出规范。';
      case 'skip':
        return '用户跳过了追问：不要再问任何问题，直接给出简短收束反馈。';
      default:
        return '不要提问。';
    }
  }

  /** 复盘上下文（ER-R01 R6）：已启用原则卡与当前实验纳入提示词；总量受 24KiB 输入上限约束。 */
  /** 复盘上下文（ER-R01 R6）：已启用原则卡与当前实验纳入提示词；总量受 24KiB 输入上限约束。 */
  function buildContextBlock(): string {
    const parts: string[] = [];
    try {
      const cards = enabledPrinciples(db, 6);
      if (cards.length > 0) {
        const lines = cards.map(
          (c) =>
            '- [' + c.id + '] ' + c.quoteOriginal +
            (c.interpretation ? '（解读：' + c.interpretation + '）' : '') +
            '｜出处：' + c.position + '｜边界：' + (c.boundary || '见卡'),
        );
        parts.push(
          '可参考的原则卡（日报引用时必须带方括号内的 principle_id，不得编造其他书籍来源）：\n' +
          lines.join('\n'),
        );
      }
      const exp = activeExperiment(db);
      if (exp && exp.status === 'running') {
        parts.push(
          '进行中的最小实验：' + exp.action + '（周期 ' + exp.periodDays + ' 天；关键假设：' + (exp.hypotheses[exp.keyIndex] ?? '') + '）。若今天的讲述与此相关，可在反馈中自然提及其观察。',
        );
      }
    } catch {
      // 上下文增强失败不阻断复盘
    }
    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  }

  function buildSystemPrompt(session: SessionRecord, phase: SessionRecord['phase']): string {
    const template = loadPrompt(deps.promptsBaseDir, session.promptVersion || PROMPT_VERSION, 'feedback-chat');
    return (
      fillTemplate(template, {
        DATE: session.date,
        QUESTION_RULE: questionRule(phase, session.followupUsed),
      }) +
      '\n\n' +
      buildContextBlock()
    );
  }

  function prices(): PriceConfig {
    const s = getSettings(db);
    return { inCnyPerMtok: s.priceInCnyPerMtok ?? 8, outCnyPerMtok: s.priceOutCnyPerMtok ?? 8 };
  }

  function budgetLimit(): number {
    return getSettings(db).budgetMonthlyCny;
  }

  function notifyBudget(): void {
    const spend = effectiveSpendCny(db);
    const limit = budgetLimit();
    deps.notifyApp({ type: 'budget', monthlySpendCny: spend, limitCny: limit, paused: spend >= limit });
  }

  /** 创建请求行 + 预占（ER-R01 第二轮 B3）：统一走 budget.reserve 事务入口，
   *  输入/输出分价、预占上限=实际 max_tokens，检查与预占原子完成。 */
  function beginRequest(
    sessionId: string | null,
    kind: 'chat' | 'refine' | 'fix',
    estInTokens: number,
  ): { requestId: string; usageId: string } | { error: 'budget_paused'; spendCny: number; limitCny: number } {
    const requestId = newId();
    const slot = reserve(
      db,
      {
        requestId,
        kind,
        estInTokens,
        maxOutTokens: OUTPUT_ESTIMATE[kind],
        price: prices(),
        limitCny: budgetLimit(),
      },
      // S2：请求记录与预占同一事务——要么都成立，要么都不发生
      () => {
        run(
          db,
          `INSERT INTO model_requests (id, session_id, kind, prompt_version, status, payload_summary, created_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
          requestId,
          sessionId,
          kind,
          PROMPT_VERSION,
          kindLabel(kind) + ' · 输入约 ' + estInTokens + ' 字符',
          nowIso(),
        );
      },
    );
    if (!slot.allowed) {
      return { error: 'budget_paused', spendCny: slot.spendCny, limitCny: slot.limitCny };
    }
    notifyBudget();
    return { requestId, usageId: slot.usageId! };
  }

  function kindLabel(kind: string): string {
    return kind === 'chat' ? '流式反馈' : 'JSON 提炼';
  }

  function insertMessage(args: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system-note';
    kind?: 'text' | 'skip-note' | 'feedback';
    content: string;
    requestId?: string | null;
    state?: string;
  }): MessageRecord {
    const id = newId();
    run(
      db,
      `INSERT INTO messages (id, session_id, role, kind, content, request_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      args.sessionId,
      args.role,
      args.kind ?? 'text',
      args.content,
      args.requestId ?? null,
      args.state ?? 'verified',
      nowIso(),
    );
    return {
      id,
      sessionId: args.sessionId,
      role: args.role,
      kind: (args.kind ?? 'text') as MessageRecord['kind'],
      content: args.content,
      requestId: args.requestId ?? null,
      state: (args.state ?? 'verified') as MessageRecord['state'],
      createdAt: nowIso(),
    };
  }

  function settleUsage(usageId: string, usage: BmUsage | null, estIn: number, kind: 'chat' | 'refine' | 'fix'): void {
    settle(db, usageId, usage, estIn, OUTPUT_ESTIMATE[kind], prices());
  }

  function finishRequest(requestId: string, status: 'verified' | 'unknown' | 'failed', errorClass?: ErrorClass, errorMessage?: string, rawResponse?: string): void {
    run(
      db,
      `UPDATE model_requests SET status = ?, error_class = ?, error_message = ?, raw_response = COALESCE(?, raw_response), finished_at = ? WHERE id = ?`,
      status,
      errorClass ?? null,
      errorMessage ?? null,
      rawResponse ?? null,
      nowIso(),
      requestId,
    );
  }

  function refundHeld(requestId: string): void {
    const u = findHeldUsage(db, requestId);
    if (u) refund(db, u.id);
    notifyBudget();
  }

  /** 执行一轮助手反馈（send 与 retry 共用） */
  async function runAssistantTurn(session: SessionRecord, phase: SessionRecord['phase'], questionRuleKey: string): Promise<{
    ok: boolean;
    error?: string;
    detail?: string;
    spendCny?: number;
    limitCny?: number;
  }> {
    const system = buildSystemPrompt(session, questionRuleKey as SessionRecord['phase']);
    const history = buildHistory(session.id);
    const messages = [{ role: 'system' as const, content: system }, ...history];

    const serialized = JSON.stringify(messages);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_INPUT_BYTES) {
      const requestId = newId();
      run(
        db,
        `INSERT INTO model_requests (id, session_id, kind, prompt_version, status, error_class, error_message, created_at, finished_at)
         VALUES (?, ?, 'chat', ?, 'failed', 'input_limit', ?, ?, ?)`,
        requestId,
        session.id,
        PROMPT_VERSION,
        `输入 ${bytes} 字节，超过上限 ${MAX_INPUT_BYTES}`,
        nowIso(),
        nowIso(),
      );
      deps.notifyModel({
        type: 'error',
        sessionId: session.id,
        error: `本次输入约 ${Math.round(bytes / 1024)}KB，超过 24KB 上限。请结束复盘生成日报，或明天开新对话。`,
        errorClass: 'input_limit',
      });
      return { ok: false, error: 'input_limit', detail: `输入 ${bytes} 字节超上限` };
    }

    const estIn = messages.reduce((n, m) => n + m.content.length, 0);
    const started = beginRequest(session.id, 'chat', estIn);
    if ('error' in started) {
      deps.notifyModel({
        type: 'error',
        sessionId: session.id,
        error: `本月模型费用已达预算上限（${started.spendCny} / ${started.limitCny} 元），已暂停调用；本地记录不受影响。可在设置中调整预算。`,
        errorClass: 'budget',
      });
      return { ok: false, error: 'budget_paused', spendCny: started.spendCny, limitCny: started.limitCny };
    }
    const { requestId, usageId } = started;

    const ctrl = new AbortController();
    inflight.set(session.id, ctrl);
    const api = resolveApiConfig(db); // 多模型兼容：接口地址与模型名来自设置（默认 BigModel）
    const bmDeps: BmDeps = { apiKey: getApiKey(db, deps.cryptor) ?? '', fetchFn: deps.fetchFn, chatUrl: api.chatUrl, model: api.model };
    try {
      const result = await streamChat(bmDeps, {
        messages,
        signal: ctrl.signal,
        maxTokens: OUTPUT_ESTIMATE.chat,
        onDelta: (text) => deps.notifyModel({ type: 'delta', sessionId: session.id, text }),
      });
      settleUsage(usageId, result.usage, estIn, 'chat');
      finishRequest(requestId, 'verified');
      // R7：计数与展示一致——达到上限/跳过/深入后，追问行在进入界面前剥离；
      // 未达上限时每个【追问】块只取第一行（单问约束），多问部分省略并注明。
      const FQ = new RegExp('(^|\n)[	]*【追问】[ 	t]*');
      const FQ_LINE = new RegExp('(^|\n)[	]*【追问】[ 	t]*[^\n]*', 'g');
      let displayContent = result.content;
      let asked = false;
      if (phase !== 'deep' && session.followupUsed < MAX_FOLLOWUPS) {
        const m = FQ.exec(result.content);
        if (m) {
          asked = true;
          const head = result.content.slice(0, m.index);
          const rest = result.content.slice(m.index + m[0].length);
          const firstLineEnd = rest.indexOf('\n');
          const firstLineRaw = (firstLineEnd >= 0 ? rest.slice(0, firstLineEnd) : rest).trim();
          const tail = firstLineEnd >= 0 ? rest.slice(firstLineEnd) : '';
          // N12：单问约束到问句级——一行内多问只保留第一问
          const qMatch = firstLineRaw.match(/^[^？?]*[？?]/);
          const firstQuestion = (qMatch ? qMatch[0] : firstLineRaw).trim();
          const omittedInLine = firstQuestion.length < firstLineRaw.length;
          const extraAsks = (tail.match(FQ_LINE) ?? []).length;
          const omitNote = omittedInLine || extraAsks > 0 ? '\\n（其余问题已省略：每次只问一个）' : '';
          displayContent = head + '\\n【追问】' + firstQuestion + omitNote;
        }
      } else if (FQ.test(result.content)) {
        displayContent = result.content.replace(FQ_LINE, '\n');
      }
      const followupUsed = session.followupUsed + (asked ? 1 : 0);
      let nextPhase: SessionRecord['phase'];
      if (phase === 'deep') nextPhase = 'deep';
      else if (asked) nextPhase = 'followup';
      else nextPhase = 'wrapup';
      const msg = insertMessage({
        sessionId: session.id,
        role: 'assistant',
        kind: 'feedback',
        content: displayContent,
        requestId,
      });
      run(
        db,
        `UPDATE sessions SET phase = ?, followup_used = ?, model = ? WHERE id = ?`,
        nextPhase,
        followupUsed,
        resolveApiConfig(db).model,
        session.id,
      );
      deps.notifyModel({
        type: 'done',
        sessionId: session.id,
        assistantMessageId: msg.id,
        phase: nextPhase,
        followupUsed,
      });
      return { ok: true };
    } catch (err) {
      const e = err instanceof BigModelError ? err : new BigModelError('unknown', String((err as Error)?.message ?? err));
      const unknownResult = e.errorClass === 'timeout' || e.errorClass === 'network' || e.errorClass === 'unknown';
      if (unknownResult) {
        finishRequest(requestId, 'unknown', e.errorClass, e.message);
        const u = findHeldUsage(db, requestId);
        if (u) keepHold(db, u.id);
        return { ok: false, error: 'internal', detail: e.message };
      }
      finishRequest(requestId, 'failed', e.errorClass, e.message, e.raw);
      refundHeld(requestId);
      // 终态事件（ER-R01 R4）：界面据此清理加载态；否则 streamText 残留会一直"请求中"
      deps.notifyModel({ type: 'error', sessionId: session.id, error: e.message, errorClass: e.errorClass });
      return { ok: false, error: 'internal', detail: e.message };
    } finally {
      inflight.delete(session.id);
    }
  }

  async function send(args: { sessionId: string; content: string }): Promise<{
    ok: boolean;
    error?: string;
    detail?: string;
    spendCny?: number;
    limitCny?: number;
  }> {
    const session = sessionById(args.sessionId);
    if (!session || session.status !== 'active') return { ok: false, error: 'closed' };
    if (!['narrate', 'followup', 'deep'].includes(session.phase)) {
      return { ok: false, error: 'phase', detail: `当前阶段（${session.phase}）不能发送消息` };
    }
    if (inflight.has(session.id)) return { ok: false, error: 'busy' };
    const parsed = SendContentSchema.safeParse(args.content);
    if (!parsed.success) return { ok: false, error: 'invalid', detail: '内容为空或过长' };

    // 先落库，再发送（ARCHITECTURE.md §5）
    insertMessage({ sessionId: session.id, role: 'user', kind: 'text', content: parsed.data });
    const phaseForPrompt = session.phase;
    return runAssistantTurn(session, phaseForPrompt, phaseForPrompt);
  }

  /** 用户显式重试：上一轮请求为 结果不明/失败 且其后没有助手回复时，重发助手轮次 */
  async function retry(args: { sessionId: string }): Promise<{
    ok: boolean;
    error?: string;
    detail?: string;
  }> {
    const session = sessionById(args.sessionId);
    if (!session || session.status !== 'active') return { ok: false, error: 'closed' };
    if (inflight.has(session.id)) return { ok: false, error: 'busy' };
    const msgs = all<DbMessage>(
      db,
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      session.id,
    );
    const last = msgs[0];
    if (!last || last.role !== 'user') {
      return { ok: false, error: 'phase', detail: '没有待重试的请求' };
    }
    const lastReq = last.request_id
      ? get<{ status: string; error_class: string | null }>(db, `SELECT status, error_class FROM model_requests WHERE id = ?`, last.request_id)
      : get<{ status: string; error_class: string | null }>(
          db,
          `SELECT status, error_class FROM model_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
          session.id,
        );
    if (!lastReq || !['unknown', 'failed'].includes(lastReq.status) || lastReq.error_class === 'budget' || lastReq.error_class === 'input_limit') {
      return { ok: false, error: 'phase', detail: '上一条请求不可重试' };
    }
    return runAssistantTurn(session, session.phase, session.phase);
  }

  async function skipFollowup(sessionId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
    const session = sessionById(sessionId);
    if (!session || session.status !== 'active') return { ok: false, error: 'closed' };
    if (session.phase !== 'followup') return { ok: false, error: 'phase' };
    if (inflight.has(sessionId)) return { ok: false, error: 'busy' };
    insertMessage({
      sessionId,
      role: 'user',
      kind: 'skip-note',
      content: '（用户选择跳过本轮追问，请直接继续）',
    });
    return runAssistantTurn(session, 'followup', 'skip');
  }

  async function enterDeep(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const session = sessionById(sessionId);
    if (!session || session.status !== 'active') return { ok: false, error: 'closed' };
    if (!['wrapup', 'followup', 'narrate'].includes(session.phase)) return { ok: false, error: 'phase' };
    if (inflight.has(sessionId)) return { ok: false, error: 'busy' };
    run(db, `UPDATE sessions SET phase = 'deep' WHERE id = ?`, sessionId);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 结束与提炼（D-011：JSON + 本地校验，格式修复最多一次）
  // ---------------------------------------------------------------------------

  function transcriptOf(sessionId: string): string {
    const msgs = all<DbMessage>(
      db,
      `SELECT * FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid`,
      sessionId,
    );
    return msgs
      .map((m) => `${m.role === 'user' ? '用户' : '知行'}：${m.content}`)
      .join('\n\n');
  }

  async function endSession(sessionId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
    const session = sessionById(sessionId);
    if (!session || session.status !== 'active') {
      // refine_failed 会话允许重试提炼
      if (session && session.phase === 'refine_failed') {
        return doRefine(session);
      }
      return { ok: false, error: 'closed' };
    }
    if (['refining'].includes(session.phase)) return { ok: false, error: 'busy' };
    run(db, `UPDATE sessions SET ended_at = ? WHERE id = ?`, nowIso(), sessionId);
    return doRefine(sessionById(sessionId)!);
  }

  /** 日报可信化（ER-R01 R6）：
   *  - related_ideas 的 principle_id 必须真实存在；来源文字由程序按卡生成（模型不得自由编写）；
   *    引用不存在原则的条目降级为 ai_notes 待核对项，不进入正式"相关思想"。
   *  - experiences/feelings 每条必须能在用户原话中找到依据（前缀匹配）；
   *    无依据条目同样降级为 ai_notes，不作为用户自述正式化。 */
  /** W2/G2/H1：跨修订延续的**可信**状态只来自库内**目标报告日期**的既有正式日报——
   *  已确认感受 + 已接受行动（含确认时间）。模型结果不携带任何确认状态。
   *  H1：必须按将要发布的 session.date 读取，不得从当前墙钟推导——
   *  午夜后收束的复盘仍归属开始那天的日期，读墙钟会丢掉该日已确认状态或混入新一天的记录。 */
  function prevTrusted(reportDate: string): { confirmed: string[]; accepted: import('../shared/schemas').DailyReportContent['actions_accepted'] } {
    const prev = latestReportByDate(db, reportDate);
    if (!prev) return { confirmed: [], accepted: [] };
    try {
      const c = JSON.parse(prev.content_json) as {
        feelings_confirmed?: string[];
        actions_accepted?: import('../shared/schemas').DailyReportContent['actions_accepted'];
      };
      // G2 去重规则：同一行动文本保留**最早**的确认时间（确认状态只能前进，不因合并漂移）
      const byAction = new Map<string, import('../shared/schemas').DailyReportContent['actions_accepted'][number]>();
      for (const a of c.actions_accepted ?? []) {
        const hit = byAction.get(a.action);
        if (!hit || a.accepted_at < hit.accepted_at) byAction.set(a.action, a);
      }
      return { confirmed: c.feelings_confirmed ?? [], accepted: [...byAction.values()] };
    } catch {
      return { confirmed: [], accepted: [] };
    }
  }

  function sanitizeReport(
    content: import('../shared/schemas').DailyReportContent,
    sessionId: string,
    allowedIdeaIds?: string[],
    reportDate?: string,
  ): import('../shared/schemas').DailyReportContent {
    // T3 数据合同：正式事实 = 用户原话摘录（整句逐字包含于某条用户消息，带 message_id 溯源）；
    // 归纳/改写/推断一律不满足完全包含 → 降级为待核对（不静默截断）。来源卡绑定本次 ID + 快照。
    const userMsgs = all<DbMessage>(
      db,
      `SELECT id, content FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'text'`,
      sessionId,
    );
    const evidenceOf = (item: string): string | null => {
      for (const m of userMsgs) {
        if (m.content.includes(item)) return m.id;
      }
      return null;
    };

    const demoted: string[] = [];
    const factSources: import('../shared/schemas').DailyReportContent['fact_sources'] = [];
    const keepFact = (item: string): boolean => {
      const mid = evidenceOf(item);
      if (mid === null) return false;
      factSources.push({ item, messageId: mid });
      return true;
    };

    const validIdeas: import('../shared/schemas').DailyReportContent['related_ideas'] = [];
    const allowed = new Set(allowedIdeaIds ?? []);
    for (const idea of content.related_ideas) {
      const card = get<{ id: string; position: string; enabled: number; snapshot_id: string | null }>(
        db,
        `SELECT id, position, enabled, snapshot_id FROM principle_cards WHERE id = ?`,
        idea.principle_id,
      );
      if (!card || !allowed.has(idea.principle_id) || card.enabled !== 1) {
        demoted.push('（待核对）' + idea.idea + '——引用了本次未提供/不存在/未启用的思想来源，需人工确认');
        continue;
      }
      validIdeas.push({
        idea: idea.idea,
        principle_id: idea.principle_id,
        snapshot_id: card.snapshot_id ?? undefined,
        source: card.position + '（原则卡 ' + card.id + '）',
        kind: '解读',
      });
    }

    const experiences = content.experiences.filter((e) => {
      if (keepFact(e)) return true;
      demoted.push('（待核对）' + e + '——未在你的原话中逐字找到，确认后可升级为事实');
      return false;
    });
    // W2：感受不能由模型归纳自动正式化——词出现在否定句/转述/假设中不是"用户承认"。
    // 模型归纳的感受全部进入待核对；正式感受仅来自用户在界面上的显式确认（feelings_confirmed）。
    const feelings: string[] = [];
    for (const f of content.feelings) {
      demoted.push('（待核对感受）「' + f + '」——如确属你的感受，请在日报中确认；含否定/转述/假设时不应确认');
    }

    // T3：待核对项不静默截断——超限时保留全部待核对，显式注明被省略的模型假设数量
    const merged = [...demoted, ...content.ai_notes];
    const AI_CAP = 50;
    let aiNotes = merged;
    if (merged.length > AI_CAP) {
      const dropped = merged.length - (AI_CAP - 1);
      aiNotes = merged.slice(0, AI_CAP - 1);
      aiNotes.push('（另有 ' + dropped + ' 条 AI 假设/待核对未展示，请到对话页查看原对话）');
    }

    // F2/G2/H1：确认/接受/溯源字段程序所有——不从模型结果展开继承（`...content` 之外显式覆盖）。
    // 正式感受、确认记录与已接受行动只来自两处：库内**目标日期**既有正式日报（可信历史合并）+
    // 用户界面确认链路。G2：已接受行动（含确认时间）同样跨修订保留；H1：目标日期 = 将要发布的
    // session.date（午夜后收束仍归属开始日期），不从墙钟推导、不串入其他日期的确认记录。
    const trusted = prevTrusted(reportDate ?? localDate());
    return {
      ...content,
      experiences,
      feelings: trusted.confirmed,
      feelings_confirmed: trusted.confirmed,
      actions_accepted: trusted.accepted,
      related_ideas: validIdeas,
      ai_notes: aiNotes,
      fact_sources: factSources,
    };
  }

  async function doRefine(session: SessionRecord): Promise<{ ok: boolean; error?: string; detail?: string }> {
    if (inflight.has(session.id)) return { ok: false, error: 'busy' };
    run(db, `UPDATE sessions SET phase = 'refining' WHERE id = ?`, session.id);
    deps.notifyApp({ type: 'refine', sessionId: session.id, status: 'started' });

    const transcript = transcriptOf(session.id);
    const coverageStats = `日期 ${session.date}；${session.kind === 'short' ? '简短模式' : '对话模式'}；共 ${transcript.length > 0 ? transcript.split('\n\n').length : 0} 条发言；记录时段 ${hhmm(session.startedAt)}–${hhmm(nowIso())}。`;
    const template = loadPrompt(deps.promptsBaseDir, PROMPT_VERSION, 'refine-report');
    // B6：给提炼提供可用原则卡集合（principle_id 只能从中选择），与 schema/prompt 三方一致
    const enabledCards = enabledPrinciples(db, 8);
    const allowedIdeaIds = enabledCards.map((c) => c.id);
    const principlesList = enabledCards
      .map((c) => '- [' + c.id + '] ' + c.position)
      .join('\n');
    const system = fillTemplate(template, {
      DATE: session.date,
      COVERAGE: coverageStats,
      PRINCIPLES: principlesList || '（空：本次没有已启用的原则卡，related_ideas 必须为空数组）',
    });
    const chatMessages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: `对话原稿：\n\n${transcript}` },
    ];

    const estIn = system.length + transcript.length;
    const started = beginRequest(session.id, 'refine', estIn);
    if ('error' in started) {
      run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE id = ?`, session.id);
      deps.notifyApp({
        type: 'refine', sessionId: session.id, status: 'failed',
        message: `本月模型费用已达预算上限（${started.spendCny} / ${started.limitCny} 元），提炼暂停；对话已保存，可稍后重试。`,
      });
      notifyBudget();
      return { ok: false, error: 'budget_paused' };
    }
    const { requestId, usageId } = started;
    const ctrl = new AbortController();
    inflight.set(session.id, ctrl);
    const api = resolveApiConfig(db); // 多模型兼容：接口地址与模型名来自设置（默认 BigModel）
    const bmDeps: BmDeps = { apiKey: getApiKey(db, deps.cryptor) ?? '', fetchFn: deps.fetchFn, chatUrl: api.chatUrl, model: api.model };

    const failRefine = (message: string, raw?: string): { ok: false; error: string; detail: string } => {
      finishRequest(requestId, 'failed', undefined, message, raw);
      run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE id = ?`, session.id);
      deps.notifyApp({ type: 'refine', sessionId: session.id, status: 'failed', message });
      return { ok: false, error: 'internal', detail: message };
    };

    try {
      const first = await completeChat(bmDeps, { messages: chatMessages, signal: ctrl.signal });
      // 完整响应先保存，再校验（ARCHITECTURE §5.5）
      run(db, `UPDATE model_requests SET raw_response = ? WHERE id = ?`, first.content, requestId);
      settleUsage(usageId, first.usage, estIn, 'refine');
      let parsed = parseDailyReportJson(first.content);

      if (!parsed.ok) {
        // 格式修复：最多一次并计入预算（D-011）
        const fix = beginRequest(session.id, 'fix', estIn + first.content.length);
        if ('error' in fix) {
          finishRequest(requestId, 'failed', undefined, '校验失败且修复预占被预算拦截', first.content);
          run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE id = ?`, session.id);
          deps.notifyApp({
            type: 'refine', sessionId: session.id, status: 'failed',
            message: '日报 JSON 校验失败，且修复调用被预算拦截；草稿已保留，可稍后重试。',
          });
          return { ok: false, error: 'internal', detail: 'fix blocked by budget' };
        }
        try {
          const fixResult = await completeChat(bmDeps, {
            messages: [
              ...chatMessages,
              { role: 'assistant' as const, content: first.content },
              {
                role: 'user' as const,
                content: `上面的 JSON 校验未通过：\n${parsed.errors.map((e) => `- ${e}`).join('\n')}\n请只输出修正后的完整 JSON（不要代码块、不要解释）。`,
              },
            ],
            signal: ctrl.signal,
          });
          run(db, `UPDATE model_requests SET raw_response = ? WHERE id = ?`, fixResult.content, fix.requestId);
          settleUsage(fix.usageId, fixResult.usage, estIn + first.content.length, 'fix');
          finishRequest(fix.requestId, 'verified');
          parsed = parseDailyReportJson(fixResult.content);
          if (!parsed.ok) return failRefine('日报 JSON 两次校验未通过，草稿已保留，可重试。', first.content);
        } catch (err) {
          const e = err instanceof BigModelError ? err : new BigModelError('unknown', String((err as Error)?.message ?? err));
          finishRequest(fix.requestId, e.errorClass === 'timeout' || e.errorClass === 'network' ? 'unknown' : 'failed', e.errorClass, e.message);
          if (e.errorClass !== 'timeout' && e.errorClass !== 'network') {
            const u = findHeldUsage(db, fix.requestId);
            if (u) refund(db, u.id);
          }
          return failRefine(`格式修复调用失败（${e.message}），草稿已保留，可重试。`, first.content);
        }
      } else {
        finishRequest(requestId, 'verified');
      }

      // 成功：日报正式化 + 自动导出 + 会话关闭
      // S10：单事务 + 每日期唯一当前正式版索引
      const report = insertCurrentRevision(db, {
        date: session.date,
        sourceSessionId: session.id,
        content: sanitizeReport(parsed.content, session.id, allowedIdeaIds, session.date), // H1：按目标报告日期读取可信历史
        model: resolveApiConfig(db).model,
        promptVersion: PROMPT_VERSION,
        requestId,
        formal: true,
      });
      queueReportExport(db, report, deps.appVersion, deps.notifyApp);
      run(db, `UPDATE sessions SET phase = 'closed', status = 'closed' WHERE id = ?`, session.id);
      deps.notifyApp({
        type: 'refine', sessionId: session.id, status: 'ok',
        reportId: report.id, rev: report.rev,
      });
      return { ok: true };
    } catch (err) {
      const e = err instanceof BigModelError ? err : new BigModelError('unknown', String((err as Error)?.message ?? err));
      if (e.errorClass === 'timeout' || e.errorClass === 'network' || e.errorClass === 'unknown') {
        finishRequest(requestId, 'unknown', e.errorClass, e.message);
        const u = findHeldUsage(db, requestId);
        if (u) keepHold(db, u.id);
        run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE id = ?`, session.id);
        deps.notifyApp({
          type: 'refine', sessionId: session.id, status: 'failed',
          message: `提炼请求${e.errorClass === 'timeout' ? '超时' : '网络中断'}（结果不明，费用预占保留）；对话已保存，可重试。`,
        });
        return { ok: false, error: 'internal', detail: e.message };
      }
      finishRequest(requestId, 'failed', e.errorClass, e.message, e.raw);
      refundHeld(requestId);
      run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE id = ?`, session.id);
      deps.notifyApp({
        type: 'refine', sessionId: session.id, status: 'failed',
        message: `提炼失败：${e.message}（对话已保存，可重试）`,
      });
      return { ok: false, error: 'internal', detail: e.message };
    } finally {
      inflight.delete(session.id);
    }
  }

  function cancelAll(): void {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  }

  return {
    getToday, startChat, startShort, send, retry, skipFollowup, enterDeep, endSession, cancelAll,
    inflight,
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 启动中断恢复（ER-R01 R4）：遗留 running 请求 = 结果不明；refining 会话转为可重试。
 *  不自动重发任何收费请求；用户可显式重试。 */
export function recoverInterrupted(db: Db): void {
  run(
    db,
    `UPDATE model_requests SET status = 'unknown', error_class = COALESCE(error_class, 'unknown'),
       error_message = COALESCE(error_message, '应用退出，请求中断（结果不明）'), finished_at = COALESCE(finished_at, ?)
     WHERE status = 'running'`,
    nowIso(),
  );
  run(db, `UPDATE sessions SET phase = 'refine_failed' WHERE phase = 'refining' AND status = 'active'`);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface DbSession {
  id: string; date: string; kind: string; phase: string; followup_used: number;
  status: string; prompt_version: string; model: string | null; started_at: string; ended_at: string | null;
}

function mapSession(r: DbSession): SessionRecord {
  return {
    id: r.id, date: r.date, kind: r.kind as SessionRecord['kind'], phase: r.phase as SessionRecord['phase'],
    followupUsed: r.followup_used, status: r.status as SessionRecord['status'],
    promptVersion: r.prompt_version, model: r.model, startedAt: r.started_at, endedAt: r.ended_at,
  };
}

interface DbMessage {
  id: string; session_id: string; role: string; kind: string; content: string;
  request_id: string | null; state: string; created_at: string;
}

function mapMessage(m: DbMessage): MessageRecord {
  return {
    id: m.id, sessionId: m.session_id, role: m.role as MessageRecord['role'], kind: m.kind as MessageRecord['kind'],
    content: m.content, requestId: m.request_id, state: m.state as MessageRecord['state'], createdAt: m.created_at,
  };
}

export const REQUEST_TIMEOUT_NOTE = `请求超时上限 ${REQUEST_TIMEOUT_MS / 1000} 秒`;
