// 知行 MCP 服务器（ER-M01）：把本地复盘数据封装为 Model Context Protocol 工具。
// 安全边界（docs/DECISIONS.md D-019）：
//   - 只做本地数据读写（SQLite + Obsidian 导出），不携带 API Key、不发起任何模型调用；
//   - 原则卡仅可列表/新增草稿，"确认启用"门只保留在应用界面；
//   - 实验约束（单进行中、周期 ≤7 天、三假设）与产品规则全部复用主进程同一套实现。
// 构建：npm run mcp:build（esbuild 打包为自包含单文件 mcp/server.mjs，Node ≥ 20 直接运行）。
// 运行：node mcp/server.mjs   （数据库路径解析见 resolveDbPath；可用 ZHIXING_DB_PATH 覆盖）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { openDb, type Db } from '../../src/main/db';
import { createSessionService } from '../../src/main/session';
import { listRecentReports, reportsByDate, viewReports } from '../../src/main/reports';
import { listPrinciples, addDraftCard } from '../../src/main/principles';
import { activeExperiment, addObservation, concludeExperiment, createExperimentDraft, listExperiments } from '../../src/main/experiments';
import { listPeriodReports } from '../../src/main/periodic';
import { effectiveSpendCny } from '../../src/main/budget';
import { getPublicSettings } from '../../src/main/settings';
import { runExportTask, exportTasksFor } from '../../src/main/obsidian';
import { ExperimentCreateSchema, localDate } from '../../src/shared/schemas';
import type { CryptorLike } from '../../src/main/session';

// ---------------------------------------------------------------------------
// 数据库定位与打开
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  if (process.env.ZHIXING_DB_PATH) return process.env.ZHIXING_DB_PATH;
  const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
  // 打包版 productName=知行；开发态 package name=evening-reflection
  for (const name of ['知行', 'evening-reflection']) {
    const p = join(appData, name, 'zhixing.db');
    if (existsSync(p)) return p;
  }
  return join(appData, '知行', 'zhixing.db');
}

const DB_PATH = resolveDbPath();
mkdirSync(join(DB_PATH, '..'), { recursive: true });
const db: Db = openDb(DB_PATH);
// 与常驻应用并发：WAL 允许多读单写，busy_timeout 保证写入等待而非报错
db.exec('PRAGMA busy_timeout = 5000;');
// R10/N8：Obsidian 目录覆盖由环境变量 ZHIXING_OBSIDIAN_DIR 实现，obsidian.effectiveVaultDir
// 在本进程内优先读取它——进程局部、只读、无共享库写入、无窗口期与残留；桌面应用不受影响。

// 领域服务（cryptor/通知在 MCP 场景不会被用到：短模式与数据工具不触模型）
const dummyCryptor: CryptorLike = { available: () => false, encrypt: () => '', decrypt: () => null };
const noop = (): void => undefined;
const session = createSessionService({
  db,
  promptsBaseDir: join(process.cwd(), 'resources'),
  appVersion: 'mcp',
  cryptor: dummyCryptor,
  notifyModel: noop,
  notifyApp: noop,
});

const text = (v: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});
const fail = (detail: string) => text({ ok: false, error: detail });

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'zhixing',
  version: '0.1.0',
});

server.registerTool(
  'today_snapshot',
  {
    title: '今天的复盘快照',
    description:
      '查看今天（或最近一次）复盘的状态：会话与阶段、消息列表、最新日报与导出状态。只读。',
    inputSchema: {},
  },
  async () => text({ ok: true, snapshot: session.getToday() }),
);

server.registerTool(
  'add_quick_note',
  {
    title: '只记一句',
    description:
      '简短模式：记录一句话（可附情绪标记），本地生成正式日报并单向导出到 Obsidian，不发起任何 AI 反馈、不产生费用。适合"今天就记一下"的场景。',
    inputSchema: {
      content: z.string().trim().min(1).max(500).describe('今天的一句话（≤500 字）'),
      mood: z.string().trim().max(40).optional().describe('情绪标记（可选，如：还行/一般/很累）'),
    },
  },
  async ({ content, mood }) => {
    const r = session.startShort({ content, mood });
    if (!r.ok) return fail(r.detail ?? r.error ?? '保存失败');
    // S5：轮询真实导出状态（≤3s），不猜固定等待
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 150));
      const st = session.getToday().exportTask?.status;
      if (st === 'done' || st === 'failed') break;
    }
    return text({ ok: true, snapshot: session.getToday() });
  },
);

server.registerTool(
  'get_report',
  {
    title: '查询日报',
    description: '按日期（YYYY-MM-DD，缺省今天）查询日报的全部修订版本、行动确认状态与导出任务。只读。',
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期，缺省今天'),
    },
  },
  async ({ date }) => {
    const d = date ?? localDate();
    const reports = viewReports(reportsByDate(db, d));
    return text({ ok: true, date: d, count: reports.length, reports });
  },
);

server.registerTool(
  'list_reports',
  {
    title: '列出日报',
    description: '列出最近的日报（默认 30 条），含修订与导出状态。只读。',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('条数上限，缺省 30'),
    },
  },
  async ({ limit }) => text({ ok: true, reports: viewReports(listRecentReports(db, limit ?? 30)) }),
);

server.registerTool(
  'export_report',
  {
    title: '（重新）导出日报',
    description:
      '对指定日期的最新日报执行一次 Obsidian 导出/重试（幂等：文件已存在且内容一致则直接确认）。只写本地文件，不调用模型。',
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('日期，缺省今天'),
    },
  },
  async ({ date }) => {
    const d = date ?? localDate();
    const reports = viewReports(reportsByDate(db, d));
    const latest = reports[0];
    if (!latest?.exportTask) return fail('该日期没有可导出的日报');
    const r = await runExportTask(db, latest.exportTask!.id, 'mcp');
    return r.ok
      ? text({ ok: true, status: r.status, targetRel: r.targetRel })
      : fail(r.error ?? '导出失败');
  },
);

server.registerTool(
  'list_principles',
  {
    title: '列出原则卡',
    description:
      '列出思想库原则卡（原文摘录/出处/中文解读/适用边界/启用状态）。只读；启用开关只在应用界面，MCP 无法绕过。',
    inputSchema: {
      enabledOnly: z.boolean().optional().describe('仅列出已启用的卡，缺省全部'),
    },
  },
  async ({ enabledOnly }) => {
    let cards = listPrinciples(db);
    if (enabledOnly) cards = cards.filter((c) => c.enabled);
    return text({ ok: true, count: cards.length, cards });
  },
);

server.registerTool(
  'add_principle_draft',
  {
    title: '新增原则卡草稿',
    description:
      '把一段摘录或个人建议存为原则卡草稿（默认未启用）。注意：启用必须在应用界面由用户确认，MCP 不能代为启用。',
    inputSchema: {
      text: z.string().trim().min(1).max(1000).describe('摘录或建议内容'),
      sourceUrl: z.string().trim().url().max(500).optional().describe('来源链接（可选，https）'),
      origin: z.enum(['paste', 'file', 'suggestion']).optional().describe('来源类型，缺省 paste'),
    },
  },
  async ({ text: t, sourceUrl, origin }) => {
    const card = addDraftCard(db, { text: t, sourceUrl, origin: origin ?? 'paste' });
    return text({ ok: true, card, note: '草稿默认未启用；请在应用界面确认后启用。' });
  },
);

server.registerTool(
  'list_experiments',
  {
    title: '列出小实验',
    description: '列出全部最小实验（含假设、关键项、观察记录与结论）。只读。',
    inputSchema: {},
  },
  async () => text({ ok: true, experiments: listExperiments(db), active: activeExperiment(db) }),
);

server.registerTool(
  'create_experiment',
  {
    title: '创建最小实验',
    description:
      '创建 ≤7 天的最小实验：三个假设选最关键的，明确动作/投入/指标/继续与停止条件/明天能开始的第一步。同时最多一个进行中（约束由数据层强制）。',
    inputSchema: {
      hypotheses: z.tuple([
        z.string().trim().min(1).max(300),
        z.string().trim().min(1).max(300),
        z.string().trim().min(1).max(300),
      ]).describe('恰好三个可能影响结论的假设'),
      keyIndex: z.number().int().min(0).max(2).describe('最关键假设的下标（0-2）'),
      action: z.string().trim().min(1).max(500).describe('明确做什么'),
      invest: z.string().trim().max(300).optional().describe('投入（可选）'),
      periodDays: z.number().int().min(1).max(7).describe('周期天数（≤7）'),
      metric: z.string().trim().max(300).optional().describe('观察指标（可选）'),
      continueRule: z.string().trim().max(300).optional().describe('继续条件（可选）'),
      stopRule: z.string().trim().max(300).optional().describe('停止条件（可选）'),
      firstStep: z.string().trim().min(1).max(300).describe('明天就能开始的第一步'),
    },
  },
  async (args) => {
    const parsed = ExperimentCreateSchema.safeParse(args);
    if (!parsed.success) {
      return fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
    }
    // R10：MCP 创建的是**草稿**（status='planned'，不占用"单进行中"）。
    // 启动（→running）必须在应用界面由用户显式确认并记录时间。
    const r = createExperimentDraft(db, parsed.data, { origin: 'mcp' });
    return r.ok
      ? text({ ok: true, experiment: r.experiment, note: '已保存为草稿；请在知行应用中确认后开始实验。' })
      : fail(r.error === 'active_exists' ? '已有一个进行中的实验。' : (r.detail ?? '创建失败'));
  },
);

server.registerTool(
  'add_observation',
  {
    title: '记录实验观察',
    description: '向进行中的实验追加一条带时间戳的观察记录（≤500 字）。结束后不可补记。',
    inputSchema: {
      id: z.string().min(1).describe('实验 ID'),
      text: z.string().trim().min(1).max(500).describe('观察内容'),
    },
  },
  async ({ id, text: t }) => {
    const r = addObservation(db, id, t);
    return r.ok ? text({ ok: true }) : fail(r.detail ?? '记录失败');
  },
);

server.registerTool(
  'conclude_experiment',
  {
    title: '结束实验并下结论',
    description: '登记实验的实际结果与结论/调整判断（提前止损允许）。结束后不可再补观察。',
    inputSchema: {
      id: z.string().min(1).describe('实验 ID'),
      outcome: z.string().trim().min(1).max(2000).describe('实际结果（观察到什么，不评价自己）'),
      conclusion: z.string().trim().min(1).max(2000).describe('结论与调整判断'),
    },
  },
  async ({ id, outcome, conclusion }) => {
    const r = concludeExperiment(db, id, { outcome, conclusion });
    return r.ok ? text({ ok: true }) : fail(r.detail ?? '结束失败');
  },
);

server.registerTool(
  'list_period_reports',
  {
    title: '列出周期报告',
    description: '列出周报/月报/年报（含修订号、过时标记、日报证据索引）。只读。',
    inputSchema: {},
  },
  async () => text({ ok: true, reports: listPeriodReports(db) }),
);

server.registerTool(
  'get_budget_status',
  {
    title: '查询预算状态',
    description: '本月模型费用占用与月度上限（预占+结算口径）、API Key 是否已配置。只读；不包含任何密钥。',
    inputSchema: {},
  },
  async () => {
    // R10：白名单查询——只读预算相关设置键，绝不 SELECT settings 全表（不触密钥密文）
    const whitelist = ('budget_monthly_cny,price_in_cny_per_mtok,price_out_cny_per_mtok')
      .split(',')
      .map((k) => k.trim());
    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${whitelist.map(() => '?').join(',')})`)
      .all(...whitelist) as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const num = (k: string): number | null => {
      const v = map.get(k);
      if (v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const priceIn = num('price_in_cny_per_mtok');
    const priceOut = num('price_out_cny_per_mtok');
    const hasKeyRow = db
      .prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'api_key_enc' AND value != ''`)
      .get() as { n: number };
    return text({
      ok: true,
      monthlySpendCny: Math.round(effectiveSpendCny(db) * 100) / 100,
      budgetMonthlyCny: num('budget_monthly_cny') ?? 20,
      priceIsPlaceholder: priceIn === null || priceOut === null,
      hasApiKey: hasKeyRow.n > 0,
      model: 'glm-5.3-flash',
    });
  },
);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr 只输出运行信息，不输出任何用户数据
  console.error(`[zhixing-mcp] 已连接 · 数据库 ${DB_PATH}`);
}

main().catch((err) => {
  console.error('[zhixing-mcp] 启动失败：', (err as Error).message);
  process.exit(1);
});
