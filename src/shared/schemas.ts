// Zod schemas：提炼日报 JSON 的本地校验（D-011）与设置写入校验。
// 校验失败信息会进入"格式修复"提示词（最多一次），因此错误信息必须具体、面向模型可修复。
import { z } from 'zod';
import { REPORT_LIMITS as L } from './config';

const itemText = z.string().min(1).max(L.itemText);

export const ReportIdeaSchema = z.strictObject({
  idea: itemText,
  /** 必须引用真实存在的原则卡 ID（程序解析来源文字，模型不得自由编写来源）。
   *  旧字段 source 保留只读兼容（导入旧日报），新日报一律由程序依据 principle_id 填写。 */
  principle_id: z.string().min(1).max(120),
  /** T3：启用时由程序写入该卡的快照 ID——来源绑定 ID + 快照，而非随时可编辑的定位字符串 */
  snapshot_id: z.string().min(1).max(120).optional(),
  source: z.string().min(1).max(120).optional(),
  kind: z.literal('解读'),
});

export const ReportActionSchema = z.strictObject({
  action: z.string().min(1).max(200),
  rationale: z.string().max(L.itemText).default(''),
});

/** 已确认的行动：仅用户在界面明确同意后由主进程写入（"也许可以"绝不自动变成已接受） */
export const AcceptedActionSchema = z.strictObject({
  action: z.string().min(1).max(200),
  accepted_at: z.string().min(1).max(40),
});

/** T3：正式事实的证据溯源——experiences/feelings 中每条都对应一条用户消息的完整原话 */
export const FactSourceSchema = z.strictObject({
  item: z.string().min(1).max(400),
  messageId: z.string().min(1).max(80),
});

export const DailyReportSchema = z.strictObject({
  coverage: z.string().min(1).max(L.coverage),
  experiences: z.array(itemText).max(L.itemCount),
  feelings: z.array(itemText).max(L.itemCount),
  keep_practices: z.array(itemText).max(L.itemCount),
  open_questions: z.array(itemText).max(L.itemCount),
  related_ideas: z.array(ReportIdeaSchema).max(L.ideaCount),
  // T3：ai_notes 上限放大到 50，且待核对项不得被静默截断（超出部分显式注明）
  ai_notes: z.array(itemText).max(50),
  action_candidates: z.array(ReportActionSchema).max(L.actionCount),
  actions_accepted: z.array(AcceptedActionSchema).default([]),
  fact_sources: z.array(FactSourceSchema).max(60).default([]),
  // W2：结构化感受 = 用户直接确认（确认链路写入）；模型归纳的感受保持在 ai_notes 待核对
  feelings_confirmed: z.array(z.string().min(1).max(400)).max(20).default([]),
});

export type DailyReportContent = z.output<typeof DailyReportSchema>;
export type ReportIdea = z.output<typeof ReportIdeaSchema>;
export type ReportAction = z.output<typeof ReportActionSchema>;

/**
 * 从模型输出中提取日报 JSON 并校验。
 * 容忍 ```json 围栏与前后说明文字：取首个 "{" 到最后一个 "}"。
 */
export function parseDailyReportJson(text: string):
  | { ok: true; content: DailyReportContent }
  | { ok: false; errors: string[]; raw: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, errors: ['输出中未找到 JSON 对象'], raw: text };
  }
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败：${(e as Error).message}`], raw: text };
  }
  // F2：确认/接受/溯源字段是程序所有（feelings_confirmed / actions_accepted / fact_sources），
  // 只能由用户显式操作或程序从可信历史生成——模型输出中的同名字段在解析层**剥离（忽略）**，
  // 绝不进入持久化内容。持久化 schema 仍为 DailyReportSchema（默认空），由主进程按合同填充。
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    delete obj.feelings_confirmed;
    delete obj.actions_accepted;
    delete obj.fact_sources;
  }
  const result = DailyReportSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.') || '(根)'}: ${i.message}`,
    );
    return { ok: false, errors, raw: text };
  }
  // 安全闸（F2 双保险）：即使上游改动绕过剥离，程序所有字段在这里也强制清空——
  // "也许可以"绝不变成已接受，"模型归纳"绝不变成已确认感受。
  return {
    ok: true,
    content: { ...result.data, actions_accepted: [], feelings_confirmed: [], fact_sources: [] },
  };
}

// ---------------------------------------------------------------------------
// 设置写入校验（渲染进程 → 主进程）
// ---------------------------------------------------------------------------

export const SettingsPatchSchema = z.strictObject({
  apiKey: z.string().min(8).max(200).optional(),
  obsidianDir: z.string().min(2).max(500).optional(),
  // 多模型兼容：OpenAI 兼容接口的基础地址（空串 = 恢复默认 BigModel）与模型名
  apiBaseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\//.test(v), { message: '接口地址必须以 http(s):// 开头' })
    .optional(),
  model: z.string().trim().min(1).max(120).optional(),
  budgetMonthlyCny: z.number().positive().max(10_000).optional(),
  priceInCnyPerMtok: z.number().positive().max(1_000).nullable().optional(),
  priceOutCnyPerMtok: z.number().positive().max(1_000).nullable().optional(),
  priceCheckedAt: z.string().max(40).nullable().optional(),
  reminderEnabled: z.boolean().optional(),
  reminderStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  reminderEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});
export type SettingsPatchInput = z.output<typeof SettingsPatchSchema>;

/** 短模式入参校验：一句话 + 可选情绪标记 */
export const StartShortSchema = z.strictObject({
  content: z.string().trim().min(1).max(500),
  mood: z.string().trim().max(40).optional(),
});

export const SendContentSchema = z.string().trim().min(1).max(20_000);

/** 最小实验创建（PRODUCT §5）：三个假设 → 选最关键 → 可执行定义；周期 ≤7 天 */
export const ExperimentCreateSchema = z.strictObject({
  hypotheses: z.tuple([z.string().trim().min(1).max(300), z.string().trim().min(1).max(300), z.string().trim().min(1).max(300)]),
  keyIndex: z.number().int().min(0).max(2),
  action: z.string().trim().min(1).max(500),
  invest: z.string().trim().max(300).default(''),
  periodDays: z.number().int().min(1).max(7),
  metric: z.string().trim().max(300).default(''),
  continueRule: z.string().trim().max(300).default(''),
  stopRule: z.string().trim().max(300).default(''),
  firstStep: z.string().trim().min(1).max(300),
});
export type ExperimentCreateInput = z.output<typeof ExperimentCreateSchema>;

/** 原则卡导入（粘贴摘录 / 文件内容 / 个人建议）：一律草稿，待确认启用 */
export const PrincipleDraftSchema = z.strictObject({
  text: z.string().trim().min(1).max(1000),
  sourceUrl: z.string().trim().url().max(500).optional(),
  origin: z.enum(['paste', 'file', 'suggestion']),
});

/** 本地日期 YYYY-MM-DD（用户本地时区） */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
