// IPC 通道白名单与共享类型：主进程注册、预加载暴露、渲染进程调用的唯一依据。
// 新增通道必须在此登记，并同时在主进程实现对应 handler；白名单之外一律拒绝。

export const IPC_CHANNELS = [
  'app:info',
  'settings:get',
  'settings:set',
  'settings:testConnection',
  'dialog:chooseDirectory',
  'session:getToday',
  'session:start',
  'session:send',
  'session:retry',
  'session:skip',
  'session:deep',
  'session:end',
  'report:getByDate',
  'report:list',
  'report:exportRetry',
  'report:acceptAction',
  'report:confirmFeeling',
  'reports:periodList',
  'reports:periodGenerate',
  'reports:periodExportRetry',
  'export:openLocation',
  'export:bindTargetAndRetry',
  'principles:list',
  'principles:setEnabled',
  'principles:addDraft',
  'principles:updateDraft',
  'experiments:list',
  'experiments:active',
  'experiments:create',
  'experiments:start',
  'experiments:observe',
  'experiments:conclude',
  'app:openExternal',
  'data:backup',
  'data:restore',
] as const;

/** 主进程 → 渲染进程的事件通道（同样仅限白名单） */
export const EVENT_CHANNELS = ['model:event', 'app:event'] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** 模型请求/接口错误的分类（面向"测试连接"明确报因与界面提示） */
export type ErrorClass =
  | 'auth'
  | 'balance'
  | 'rate_limit'
  | 'model'
  | 'input_limit'
  | 'budget'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown';

export function isIpcChannel(value: string): value is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(value);
}

export function isEventChannel(value: string): value is EventChannel {
  return (EVENT_CHANNELS as readonly string[]).includes(value);
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// 领域记录
// ---------------------------------------------------------------------------

export type SessionPhase =
  | 'narrate'       // 自由讲述（首轮）
  | 'followup'      // 等待/进行追问（最多 2 个）
  | 'wrapup'        // 收束（不再追问，可结束或深入）
  | 'deep'          // 深入对话（用户主动选择）
  | 'refining'      // 提炼日报中
  | 'refine_failed' // 提炼失败（草稿保留，可重试）
  | 'closed';       // 已结束

export type SessionKind = 'chat' | 'short';

export interface SessionRecord {
  id: string;
  date: string;            // 本地日期 YYYY-MM-DD
  kind: SessionKind;
  phase: SessionPhase;
  followupUsed: number;    // 已使用的追问数（上限 2）
  status: 'active' | 'closed';
  promptVersion: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system-note';
  kind: 'text' | 'skip-note' | 'feedback';
  content: string;
  requestId: string | null;
  state: RequestState;     // 关联请求的状态（user 消息恒为 verified）
  createdAt: string;
}

export type RequestState = 'unsent' | 'running' | 'unknown' | 'verified' | 'failed';

export interface ReportRecord {
  id: string;
  date: string;
  rev: number;
  formal: boolean;         // 仅收束校验成功后为 true；不虚报正式日报
  contentJson: string;     // DailyReportContent 序列化
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  supersededBy: string | null;
}

export interface ExportTaskRecord {
  id: string;
  kind: 'daily_report';    // 扩展：period_report（ER-004）
  refId: string;
  targetRel: string;       // 相对 Vault 根的路径（正向斜杠）
  contentHash: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  // H3：目标未确认（历史 NULL 迁移标记）——任何状态下都需要用户显式选择目标，
  // 不得静默回退当前全局目录（done 任务同样如此）
  targetUnresolved: boolean;
  // L2：done 任务记录路径与内容不一致（历史遗留 done/旧路径）——页面据此提供
  // 「重新核验导出」入口，定位前不得把错误路径当作已验证报告
  targetInconsistent: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

// ---------------------------------------------------------------------------
// 思想库与小实验（ER-003）
// ---------------------------------------------------------------------------

export interface PrincipleRecord {
  id: string;
  quoteOriginal: string;   // 原文摘录（英文短引文或用户导入原文）
  sourceUrl: string | null;
  snapshotId: string | null;   // 引用必须可溯源到快照（PRODUCT §4）
  position: string;            // 出处定位（章节/小节）
  interpretation: string;      // 中文说明——一律是"解读"，不是原文
  boundary: string;            // 适用边界
  enabled: boolean;            // 生成后经用户确认才启用
  origin: string;              // 来源类型：book | quote | suggestion | import（T5）
  createdAt: string;
}

export interface ExperimentRecord {
  id: string;
  hypotheses: string[];        // 恰好三个可能影响结论的假设
  keyIndex: number;            // 选出的最关键假设
  action: string;
  invest: string;
  periodDays: number;          // ≤7
  metric: string;
  continueRule: string;
  stopRule: string;
  status: 'planned' | 'running' | 'concluded';  // planned = 草稿（MCP/导入），应用确认后启动
  firstStep: string;           // 明天就能开始的第一步
  startedAt: string;
  endedAt: string | null;
  conclusion: { outcome: string; conclusion: string } | null;
  observations: { text: string; createdAt: string }[];
}

export interface PeriodReportRecord {
  id: string;
  kind: 'weekly' | 'monthly' | 'yearly';
  periodStart: string;
  periodEnd: string;
  label: string;
  coverage: string;
  highlights: string[];
  patterns: string[];
  openQuestions: string[];
  bindings: {
    daily_report_ids: string[];   // 证据索引：结论可回溯到具体日报修订
    model: string | null;
    prompt_version: string | null;
    rev: number;
  };
  stale: boolean;                 // 绑定的日报出现新修订后为 true，可重新生成（旧版保留）
  // G4：最新导出任务（周期报告与日报同等的导出状态/重试/解决目标入口）
  exportTask: ExportTaskRecord | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** 返回给渲染进程的设置：永远不含 API Key 明文或密文 */
export interface PublicSettings {
  hasApiKey: boolean;
  apiBaseUrl: string;
  model: string;
  obsidianDir: string;
  budgetMonthlyCny: number;
  monthlySpendCny: number;
  priceInCnyPerMtok: number;
  priceOutCnyPerMtok: number;
  priceIsPlaceholder: boolean;   // true = 使用占位价（未核实），见 D-016
  priceCheckedAt: string | null;
  reminderEnabled: boolean;
  reminderStart: string;
  reminderEnd: string;
  dataDir: string;               // userData 目录（数据库所在），供说明展示
}

export interface SettingsPatch {
  apiKey?: string;               // 一次性明文（用户输入）→ safeStorage 加密入库，不回显
  obsidianDir?: string;
  budgetMonthlyCny?: number;
  priceInCnyPerMtok?: number | null;
  priceOutCnyPerMtok?: number | null;
  priceCheckedAt?: string | null;
  reminderEnabled?: boolean;     // ER-004
  reminderStart?: string;        // "HH:MM"
  reminderEnd?: string;          // "HH:MM"
}

export interface TestConnectionResult {
  ok: boolean;
  errorClass?: ErrorClass;
  message: string;               // 面向用户的中文说明
  raw?: string;                  // 服务端原始报错摘要（不含密钥）
  usageTokens?: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// 会话操作契约
// ---------------------------------------------------------------------------

export interface TodaySnapshot {
  session: SessionRecord | null;
  messages: MessageRecord[];
  latestReport: ReportRecord | null;
  exportTask: ExportTaskRecord | null;
}

export interface StartChatResult {
  ok: boolean;
  error?: string;
  snapshot?: TodaySnapshot;
}

export interface StartShortArgs {
  content: string;   // 那一句话
  mood?: string;     // 情绪标记（可选）
}

export interface SendArgs {
  sessionId: string;
  content: string;
}

export interface SessionOpArgs {
  sessionId: string;
}

/** 通用操作结果：预算/输入上限等失败以 error 区分，供界面给不同提示 */
export interface OpResult {
  ok: boolean;
  error?: string;
  detail?: string;
  spendCny?: number;
  limitCny?: number;
}

// ---------------------------------------------------------------------------
// 事件载荷（主进程 → 渲染进程）
// ---------------------------------------------------------------------------

export type ModelEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; assistantMessageId: string; phase: SessionPhase; followupUsed: number }
  | { type: 'error'; sessionId: string; error: string; errorClass?: ErrorClass; recoverable?: boolean };

export type AppEvent =
  | { type: 'refine'; sessionId: string; status: 'started' | 'ok' | 'failed'; reportId?: string; rev?: number; message?: string }
  | { type: 'export'; taskId: string; refId: string; status: 'running' | 'done' | 'failed'; targetRel?: string; error?: string }
  | { type: 'budget'; monthlySpendCny: number; limitCny: number; paused: boolean };
