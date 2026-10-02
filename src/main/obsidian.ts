// Obsidian 单向导出（docs/ARCHITECTURE.md §7）：
// - SQLite 是事实来源；导出是一次性任务（稳定 ID + 内容 hash），支持幂等重试；
// - 首次创建，修订另存（.rN），绝不覆盖既有文件；重名时使用 .知行N 后缀避让；
// - 同目录临时文件 + 重命名的原子写入，写后回读核验；失败只重试导出，不重新调用模型；
// - 写入路径限制在配置的 Vault 目录内（防越界）。
// 任务类型：daily_report（日报/日报文件夹）、period_report（周报/月报/年报文件夹）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Db } from './db';
import { all, get, newId, nowIso, run, withTransaction } from './db';
import { getSettings } from './settings';
import type { DailyReportContent } from '../shared/schemas';
import type { PeriodReportRecord } from '../shared/ipc';

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 日报 → Markdown
// ---------------------------------------------------------------------------

function section(title: string, items: string[]): string {
  if (items.length === 0) return `## ${title}\n\n（本项无记录）\n`;
  return `## ${title}\n\n${items.map((s) => `- ${s}`).join('\n')}\n`;
}

export function reportToMarkdown(args: {
  date: string;
  rev: number;
  content: DailyReportContent;
  model: string | null;
  promptVersion: string | null;
  appVersion: string;
}): string {
  const { date, rev, content, model, promptVersion, appVersion } = args;
  const ideas = content.related_ideas.map(
    (i) => `- ${i.idea}（${i.kind}，来源：${i.source}）`,
  );
  const actions = content.action_candidates.map(
    (a) => `- ${a.action}${a.rationale ? ` —— ${a.rationale}` : ''}`,
  );
  const accepted = (content.actions_accepted ?? []).map(
    (a) => `- ${a.action}（用户于 ${a.accepted_at} 确认）`,
  );
  return `---
date: "${date}"
type: 晚间复盘
revision: ${rev}
generator: "知行 (evening-reflection) v${appVersion}"
model: "${model ?? '本地生成（简短模式）'}"
prompt_version: "${promptVersion ?? '-'}"
---

# 晚间复盘 · ${date}

> 覆盖范围：${content.coverage}
> 本笔记由知行单向导出；在 Obsidian 中的手工修改不会回流应用。

${section('当天经历', content.experiences)}
${section('明确感受', content.feelings)}
${section('值得保留的做法', content.keep_practices)}
${section('待验证的解释', content.open_questions)}
## 相关思想

${
  ideas.length > 0
    ? `${ideas.join('\n')}\n`
    : '（本项无记录）\n'
}
${section('AI 假设（供核对，非事实）', content.ai_notes)}
## 行动候选（未经确认，不视为已接受）

${actions.length > 0 ? `${actions.join('\n')}\n` : '（无）\n'}
## 已确认的行动

${accepted.length > 0 ? `${accepted.join('\n')}\n` : '（无）\n'}
`;
}

// ---------------------------------------------------------------------------
// 周期报告 → Markdown（周报/月报/年报）
// ---------------------------------------------------------------------------

function periodList(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '（无）';
}

export function periodReportToMarkdown(r: PeriodReportRecord, appVersion: string): string {
  const kindCn = r.kind === 'weekly' ? '周报' : r.kind === 'monthly' ? '月报' : '年报';
  return `---
period: "${r.periodStart} ~ ${r.periodEnd}"
type: "${kindCn}"
revision: ${r.bindings.rev}
generator: "知行 (evening-reflection) v${appVersion}"
model: "${r.bindings.model ?? '-'}"
prompt_version: "${r.bindings.prompt_version ?? '-'}"
stale: "${r.stale ? 'true（日报已更新，可在应用内重新生成）' : 'false'}"
---

# ${kindCn} · ${r.periodStart} ~ ${r.periodEnd}

> 覆盖范围：${r.coverage}
> 本笔记由知行单向导出；在 Obsidian 中的手工修改不会回流应用。
> 证据索引：本报告绑定 ${r.bindings.daily_report_ids.length} 份日报（修订关系见应用内记录）；层层摘要不作为事实来源。

## 值得记下

${periodList(r.highlights)}

## 反复出现的模式

${periodList(r.patterns)}

## 下周期值得验证

${periodList(r.openQuestions)}
`;
}

// ---------------------------------------------------------------------------
// 原子发布原语（ER-R01 R3）
// ---------------------------------------------------------------------------

import { linkSync } from 'node:fs';

/**
 * 无覆盖原子发布：把暂存文件发布到 finalPath。
 * - link（硬链接）+ 暂存清理：link 在目标已存在时失败（Windows 同样成立），等价 O_EXCL+RENAME；
 *   与 renameSync 不同，link 由内核仲裁"目标存在就不碰"——检查与发布之间没有覆盖窗口。
 * - 目标已存在且内容一致 → 幂等确认（sameContent=true）；
 * - 目标已存在且内容不同 → 返回 exists=true 交由调用方避让，本函数不写入。
 */
export async function publishFileNoClobber(
  stagingPath: string,
  finalPath: string,
): Promise<{ published: boolean; finalPath: string; sameContent?: boolean; exists?: boolean }> {
  if (existsSync(finalPath)) {
    if (sha256Hex(readFileSync(finalPath)) === sha256Hex(readFileSync(stagingPath))) {
      try { unlinkIfExists(stagingPath); } catch { /* 尽力清理 */ }
      return { published: true, finalPath, sameContent: true };
    }
    return { published: false, finalPath, exists: true };
  }
  try {
    linkSync(stagingPath, finalPath); // 目标已存在 → EEXIST（不会覆盖）
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      if (sha256Hex(readFileSync(finalPath)) === sha256Hex(readFileSync(stagingPath))) {
        try { unlinkIfExists(stagingPath); } catch { /* 尽力清理 */ }
        return { published: true, finalPath, sameContent: true };
      }
      return { published: false, finalPath, exists: true };
    }
    throw err; // 只读目录 / 权限问题等：明确失败
  }
  return { published: true, finalPath };
}

function unlinkIfExists(p: string): void {
  try { require('node:fs').unlinkSync(p); } catch { /* 尽力清理 */ }
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/** 将相对路径限制在 vault 根内；越界返回 null。
 *  实路径校验（ER-R01 R3）：解析符号链接/挂载点后的真实位置也必须在根内，
 *  不能只比较字符串中的 ..。 */
export function resolveVaultPath(vaultDir: string, rel: string): string | null {
  const root = resolve(vaultDir);
  const full = resolve(root, rel);
  const relBack = relative(root, full);
  if (relBack.startsWith('..') || isAbsolute(relBack)) return null;
  let probe = full;
  while (!existsSync(probe) && probe !== root) {
    probe = dirname(probe);
  }
  try {
    const realFull = realpathSync(probe);
    const realRoot = realpathSync(root);
    if (relative(realRoot, realFull).startsWith('..')) return null;
  } catch {
    return null;
  }
  return full;
}

/** Vault 根必须是已存在的真实目录（ER-R01 R3）：不存在时明确失败，不静默创建。 */
export function requireVaultDir(vaultDir: string): { ok: true; dir: string } | { ok: false; error: string } {
  if (!vaultDir || !vaultDir.trim()) return { ok: false, error: '未配置 Obsidian 导出目录（设置页）' };
  const root = resolve(vaultDir);
  if (!existsSync(root)) {
    return { ok: false, error: '导出目录不存在：' + root + '（请在设置中确认目录，或先创建该文件夹）' };
  }
  try {
    const st = statSync(realpathSync(root));
    if (!st.isDirectory()) return { ok: false, error: '导出路径不是目录：' + root };
  } catch {
    return { ok: false, error: '无法访问导出目录：' + root };
  }
  return { ok: true, dir: root };
}

// ---------------------------------------------------------------------------
// 导出任务
// ---------------------------------------------------------------------------

export function createExportTask(
  db: Db,
  args: { refId: string; targetRel: string; contentHash: string; kind?: string },
): string {
  const id = newId();
  const now = nowIso();
  // 附加并发合同：重试保持明确的目标 Vault——创建时锁定 effectiveVaultDir，执行时优先使用
  const vaultDir = effectiveVaultDir(db);
  run(
    db,
    `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    id,
    args.kind ?? 'daily_report',
    args.refId,
    args.targetRel,
    args.contentHash,
    vaultDir,
    now,
    now,
  );
  return id;
}

export interface ExportRunResult {
  ok: boolean;
  status: 'done' | 'failed';
  targetRel?: string;
  error?: string;
}

interface ExportPayload {
  markdown: string;
  hash: string;
  finalAbs: string;
}

/** 生效的 Vault 目录（N8）：ZHIXING_OBSIDIAN_DIR 仅对设置了它的进程生效
 *  （MCP/测试进程内覆盖），进程内只读环境变量、绝不写共享 settings 表——
 *  无窗口期、无残留、跨进程安全。 */
export function effectiveVaultDir(db: Db): string | null {
  return process.env.ZHIXING_OBSIDIAN_DIR || getSettings(db).obsidianDir || null;
}

/** F7：UNRESOLVED 导出任务的唯一解决入口——用户显式选择目标目录后：
 *  1) 校验目录真实存在；2) 持久绑定到任务记录；3) 立即重试导出（零模型调用）。
 *  vaultDir 为 null = 用户取消：不写任务、不写设置。绑定后任务目标不再漂移。 */
export async function bindTaskTargetAndExport(
  db: Db,
  taskId: string,
  vaultDir: string | null,
  appVersion: string,
): Promise<ExportRunResult & { canceled?: boolean }> {
  const task = get<{ id: string; vault_dir: string | null; status: string }>(
    db,
    `SELECT id, vault_dir, status FROM export_tasks WHERE id = ?`,
    taskId,
  );
  if (!task) return { ok: false, status: 'failed', error: '导出任务不存在' };
  if (task.vault_dir !== 'UNRESOLVED') {
    return { ok: false, status: 'failed', error: '该任务已有明确目标目录，无需重新选择（直接重试即可）' };
  }
  if (!vaultDir || !vaultDir.trim()) {
    return { ok: true, status: 'failed', canceled: true, error: '已取消：未选择目录，任务与设置均未修改' };
  }
  const vault = requireVaultDir(vaultDir);
  if (!vault.ok) return { ok: false, status: 'failed', error: vault.error };
  // J1：绑定目标、清除旧完成状态、置为可重试状态必须**同一事务**——分两次提交时，
  // 第二步失败会留下"B 目录 + done"的半完成状态（targetUnresolved=false 使页面隐藏
  // 解决入口，而 done 又让重试被提前返回，恢复状态不一致）。任一步失败整体回滚，
  // 保持原 UNRESOLVED 状态与解决入口可见。
  try {
    withTransaction(db, () => {
      // 条件更新仲裁：仅当仍为 UNRESOLVED 时绑定（并发双绑定只有一方生效）
      const claimed = run(
        db,
        `UPDATE export_tasks SET vault_dir = ?, updated_at = ? WHERE id = ? AND vault_dir = 'UNRESOLVED'`,
        vaultDir, nowIso(), taskId,
      );
      if ((claimed.changes ?? 0) !== 1) {
        throw new Error('该任务的目标已由其他操作确认，请刷新后查看');
      }
      // H3：done + UNRESOLVED 的历史任务绑定新目标后**必须重新验证**——重置为 pending
      // 让 runExportTask 重建内容并按无覆盖原语发布/核验（同内容幂等确认/异内容避让）。
      run(db, `UPDATE export_tasks SET status = 'pending', done_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), taskId);
    });
  } catch (err) {
    return { ok: false, status: 'failed', error: `绑定目标失败：${(err as Error).message}` };
  }
  // 事务提交后再执行文件导出；导出失败保留可重试任务（pending/failed + 明确 last_error）
  return runExportTask(db, taskId, appVersion);
}

/** 从事实来源重建导出内容（日报 / 周期报告）；返回 null 表示数据缺失 */
function buildPayload(db: Db, task: { kind: string; ref_id: string; target_rel: string; vault_dir?: string | null }, appVersion: string): ExportPayload {
  // W6：旧任务 UNRESOLVED → 明确报错让用户选择目标，不悄悄采用后来的设置
  if (task.vault_dir === 'UNRESOLVED') {
    throw new Error('此导出任务创建于 Vault 目录记录功能之前，目标未定：请在该任务的导出失败提示中选择「选择目标目录并导出」');
  }
  const vaultDir = task.vault_dir ?? effectiveVaultDir(db);
  if (!vaultDir) throw new Error('未配置 Obsidian 导出目录（设置页）');

  if (task.kind === 'daily_report') {
    const report = get<{ id: string; date: string; rev: number; content_json: string; model: string | null; prompt_version: string | null }>(
      db,
      `SELECT * FROM daily_reports WHERE id = ?`,
      task.ref_id,
    );
    if (!report) throw new Error('日报记录不存在');
    const content = JSON.parse(report.content_json) as DailyReportContent;
    const markdown = reportToMarkdown({
      date: report.date, rev: report.rev, content,
      model: report.model, promptVersion: report.prompt_version, appVersion,
    });
    const base = report.rev > 1 ? `${report.date}.r${report.rev}` : report.date;
    const finalAbs = resolveVaultPath(vaultDir, join('日报', `${base}.md`));
    if (!finalAbs) throw new Error('导出路径越界（Vault 目录配置异常）');
    return { markdown, hash: sha256Hex(Buffer.from(markdown, 'utf8')), finalAbs };
  }

  if (task.kind === 'period_report') {
    const row = get<{ id: string; kind: string; period_start: string; period_end: string; content_json: string; created_at: string }>(
      db,
      `SELECT * FROM period_reports WHERE id = ?`,
      task.ref_id,
    );
    if (!row) throw new Error('周期报告记录不存在');
    let parsed = {
      coverage: '', highlights: [] as string[], patterns: [] as string[], open_questions: [] as string[],
      bindings: { daily_report_ids: [] as string[], model: null as string | null, prompt_version: null as string | null, rev: 1 },
    };
    try {
      parsed = { ...parsed, ...(JSON.parse(row.content_json) as Partial<typeof parsed>) };
    } catch { /* 防御 */ }
    const dailyIds = parsed.bindings.daily_report_ids;
    const stale =
      dailyIds.length > 0
        ? all<{ id: string }>(
            db,
            `SELECT id FROM daily_reports WHERE id IN (${dailyIds.map(() => '?').join(',')}) AND superseded_by IS NOT NULL`,
            ...dailyIds,
          ).length > 0
        : false;
    const record: PeriodReportRecord = {
      id: row.id,
      kind: row.kind as PeriodReportRecord['kind'],
      periodStart: row.period_start,
      periodEnd: row.period_end,
      label: '',
      coverage: parsed.coverage,
      highlights: parsed.highlights,
      patterns: parsed.patterns,
      openQuestions: parsed.open_questions,
      bindings: parsed.bindings,
      stale,
      exportTask: null, // G4：仅用于 Markdown 渲染，不涉及任务状态
      createdAt: row.created_at,
    };
    const markdown = periodReportToMarkdown(record, appVersion);
    const finalAbs = resolveVaultPath(vaultDir, task.target_rel);
    if (!finalAbs) throw new Error('导出路径越界（Vault 目录配置异常）');
    return { markdown, hash: sha256Hex(Buffer.from(markdown, 'utf8')), finalAbs };
  }

  throw new Error(`未知导出任务类型: ${task.kind}`);
}

/** L2：轻量核验 done 任务的记录路径一致性（视图透传与定位守卫用）——
 *  文件存在于记录路径且 hash 与任务 content_hash 一致才视为一致；
 *  不一致（含历史遗留 done/旧路径指向用户笔记）→ false。不做任何写操作。 */
export function doneTaskPathConsistent(db: Db, t: { status: string; target_rel: string; content_hash: string; vault_dir: string | null }): boolean {
  if (t.status !== 'done') return true;
  try {
    if (!t.content_hash || t.content_hash === 'pending') return false;
    const vault = (t.vault_dir && t.vault_dir !== 'UNRESOLVED') ? t.vault_dir : effectiveVaultDir(db);
    if (!vault) return false;
    const full = resolveVaultPath(vault, t.target_rel);
    if (!full || !existsSync(full)) return false;
    return sha256Hex(readFileSync(full)) === t.content_hash;
  } catch {
    return false;
  }
}

/** L2：定位守卫用——记录路径上存在文件、但内容与任务 content_hash 不一致
 *  （即"会把用户同名笔记/旧报告误当已验证报告"的危险形态）才返回 true。
 *  文件缺失或目录无法解析返回 false（由 openLocation 既有的 not_found/未配置分支处理）。 */
export function doneTaskPathMismatch(db: Db, t: { status: string; target_rel: string; content_hash: string; vault_dir: string | null }): boolean {
  if (t.status !== 'done') return false;
  try {
    if (!t.content_hash || t.content_hash === 'pending') return false;
    const vault = (t.vault_dir && t.vault_dir !== 'UNRESOLVED') ? t.vault_dir : effectiveVaultDir(db);
    if (!vault) return false;
    const full = resolveVaultPath(vault, t.target_rel);
    if (!full || !existsSync(full)) return false;
    return sha256Hex(readFileSync(full)) !== t.content_hash;
  } catch {
    return false;
  }
}

/** K1：核验 done 任务的记录路径与内容是否仍然一致（用于决定是否提前返回 done）。
 *  不一致 / 无法确认（文件缺失、hash 不符、hash 未落、源数据无法重建）→ false，
 *  调用方继续走完整导出流程自我纠正。任何异常都按"不能确认"处理。 */
function doneTaskIntact(db: Db, task: { id: string; kind: string; ref_id: string; target_rel: string; content_hash: string; vault_dir: string | null }, appVersion: string): boolean {
  try {
    if (!task.content_hash || task.content_hash === 'pending') return false;
    const vault = (task.vault_dir && task.vault_dir !== 'UNRESOLVED') ? task.vault_dir : effectiveVaultDir(db);
    if (!vault) return false;
    const full = resolveVaultPath(vault, task.target_rel);
    if (!full || !existsSync(full)) return false;
    if (sha256Hex(readFileSync(full)) !== task.content_hash) return false;
    const payload = buildPayload(db, task, appVersion);
    return payload.hash === task.content_hash;
  } catch {
    return false;
  }
}

/** 执行单个导出任务：幂等（重复执行先核对已有结果），原子写入 + 回读核验 */
export async function runExportTask(db: Db, taskId: string, appVersion: string): Promise<ExportRunResult> {
  const task = get<{
    id: string; kind: string; ref_id: string; target_rel: string; content_hash: string; status: string; attempts: number; vault_dir: string | null;
  }>(db, `SELECT * FROM export_tasks WHERE id = ?`, taskId);
  if (!task) return { ok: false, status: 'failed', error: '导出任务不存在' };
  if (task.status === 'done') {
    // K1：done 不再盲目提前返回——核验"记录路径存在 + 文件内容与任务 hash 一致 +
    // 与当前事实内容一致"。不一致（含历史遗留的 done/旧路径任务）则继续走完整导出
    // 流程自我纠正：重新发布并持久化实际路径（零模型、无覆盖、原文件不覆盖）。
    if (doneTaskIntact(db, task, appVersion)) {
      return { ok: true, status: 'done', targetRel: task.target_rel };
    }
    // fall through：重新导出
  }

  const bump = (status: string, err: string | null, doneAt: string | null): void => {
    run(
      db,
      `UPDATE export_tasks SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?, done_at = COALESCE(?, done_at) WHERE id = ?`,
      status,
      err,
      nowIso(),
      doneAt,
      taskId,
    );
  };
  // J2：状态写入也在错误边界内——bump 失败返回明确错误（任务保持原状态可重试），
  // 绝不让数据库异常成为 Promise 拒绝逃出恢复边界。
  try {
    bump('running', null, null);
  } catch (err) {
    const msg = `无法更新任务状态：${(err as Error).message}`;
    try {
      // K2：尽力写回 failed 与原始错误——页面据此提供重试入口（避免 pending 无入口、
      // 重新进入页面看不到失败原因）。连 failed 也写不回时保持 pending，由启动恢复接管。
      bump('failed', msg, null);
    } catch {
      /* 尽力 */
    }
    return { ok: false, status: 'failed', error: msg };
  }

  try {
    // W6：旧任务 UNRESOLVED → 明确报错让用户选择目标（在 requireVaultDir 之前，避免误报"不存在"）
    if (task.vault_dir === 'UNRESOLVED') {
      throw new Error('此导出任务创建于 Vault 目录记录功能之前，目标未定：请在该任务的导出失败提示中选择「选择目标目录并导出」');
    }
    // 附加：重试保持创建时的目标 Vault（不随设置/环境变化漂移）
    const vault = requireVaultDir((task.vault_dir ?? effectiveVaultDir(db)) ?? '');
    if (!vault.ok) throw new Error(vault.error);
    const payload = buildPayload(db, task, appVersion);
    mkdirSync(dirname(payload.finalAbs), { recursive: true });

    // 运行时以重建内容为准刷新任务 hash（创建时可为 'pending'）
    if (task.content_hash !== payload.hash) {
      run(db, `UPDATE export_tasks SET content_hash = ? WHERE id = ?`, payload.hash, taskId);
    }

    // K1：所有成功分支统一"完成路径落库 + done 状态提交"——只有两者都持久化成功才返回
    // 成功；任一失败返回可恢复错误（任务保持 running/pending，不标记 done），后续重试会
    // 再次命中同内容幂等分支并重试落库（自我纠正，不丢文件、不覆盖用户笔记）。
    const finalizeDone = (finalPath: string): ExportRunResult => {
      const rel = relative(vault.dir, finalPath).split('\\').join('/');
      try {
        run(db, `UPDATE export_tasks SET target_rel = ?, updated_at = ? WHERE id = ?`, rel, nowIso(), taskId);
        bump('done', null, nowIso());
        return { ok: true, status: 'done', targetRel: rel };
      } catch (err) {
        const msg = `导出完成但结果持久化失败：${(err as Error).message}；请稍后重试以恢复任务记录`;
        try {
          // L1：完成处理的失败也要尽力写回 failed 与原始错误——否则任务滞留
          // running/last_error=NULL（页面显示"导出中"且没有重试入口）。
          bump('failed', msg, null);
        } catch {
          /* 写不回时保持 running：启动恢复会接管（页面有重启恢复指引） */
        }
        return { ok: false, status: 'failed', error: msg };
      }
    };

    // 目标已存在且内容一致 → 幂等确认；不同 → 避让（.知行N）；随后经无覆盖原语发布（R3）
    let finalPath = payload.finalAbs;
    const stem = payload.finalAbs.slice(0, -3); // 去掉 .md
    for (let n = 2; existsSync(finalPath); n++) {
      if (sha256Hex(readFileSync(finalPath)) === payload.hash) {
        return finalizeDone(finalPath); // K1：幂等分支同样落库实际路径
      }
      finalPath = stem + '.知行' + n + '.md';
      if (n > 50) throw new Error('目标目录重名避让失败');
    }

    // 暂存写入 → 无覆盖原子发布（link 语义：目标存在就不碰）
    const tmpPath = finalPath + '.' + task.id.slice(0, 8) + '.tmp';
    writeFileSync(tmpPath, payload.markdown, 'utf8');
    const pub = await publishFileNoClobber(tmpPath, finalPath);
    if (!pub.published && pub.exists) {
      // 竞争窗口内出现同名文件：内容一致按幂等处理；不同则再避让一次
      if (pub.sameContent) {
        return finalizeDone(finalPath); // K1：幂等分支同样落库实际路径
      }
      finalPath = stem + '.知行52.md';
      const retry = await publishFileNoClobber(tmpPath, finalPath);
      if (!retry.published) throw new Error('目标文件被并发占用，导出未完成（可重试）');
    }

    // 回读核验
    const back = readFileSync(finalPath);
    if (sha256Hex(back) !== payload.hash) {
      throw new Error('回读核验不一致，导出未确认');
    }
    return finalizeDone(finalPath);
    } catch (err) {
    const msg = (err as Error).message ?? String(err);
    try {
      bump('failed', msg, null); // J2：写不回失败状态时保留原始错误（任务保持 running，仍可由启动恢复接管）
    } catch {
      /* 尽力：不掩盖原始错误 */
    }
    return { ok: false, status: 'failed', error: msg };
  }
}

/** 启动恢复：pending/running（崩溃残留）任务重新执行；failed 留给用户显式重试。
 *  H2：不变量修复——已发布的正式报告必须至少有一条导出任务；"报告存在、任务缺失"
 *  （创建失败遗留）在启动时补排程并立即执行（零模型、幂等无覆盖发布）。
 *  J2 异步完成合同（第九轮收窄表述）：本函数为 async；runExportTask 合同是"不抛出、
 *  只返回错误结果"，本函数逐任务 await 并接住其结果——单任务失败不产生未处理拒绝、
 *  不阻断其余可恢复任务。注意：初始任务查询与两个扫掠查询**不在**逐任务错误边界内，
 *  函数在这些点仍可能抛出；调用方（index.ts）保持挂接 catch 兜底。 */
export async function recoverPendingExports(db: Db, appVersion: string): Promise<void> {
  const tasks = all<{ id: string }>(
    db,
    `SELECT id FROM export_tasks WHERE status IN ('pending','running') ORDER BY created_at`,
  );
  for (const t of tasks) {
    try {
      await runExportTask(db, t.id, appVersion);
    } catch (err) {
      // 防御性兜底：runExportTask 合同上不抛出；真有意外也只记日志，不外溢
      console.error(`[export] 任务 ${t.id} 恢复失败：${(err as Error).message}`);
    }
  }
  // H2 扫掠：日报（当前正式版）与周期报告缺任务 → 补建 pending 任务并执行。
  // 单条失败不阻断其余；本地故障持续时任务缺失仍在，下次启动/用户入口可再试。
  const missingDaily = all<{ id: string; date: string; rev: number }>(
    db,
    `SELECT r.id, r.date, r.rev FROM daily_reports r
      WHERE r.formal = 1 AND r.superseded_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM export_tasks t WHERE t.ref_id = r.id)`,
  );
  for (const r of missingDaily) {
    try {
      const base = r.rev > 1 ? `${r.date}.r${r.rev}` : r.date;
      const taskId = createExportTask(db, { refId: r.id, kind: 'daily_report', targetRel: `日报/${base}.md`, contentHash: 'pending' });
      await runExportTask(db, taskId, appVersion);
    } catch (err) {
      console.error(`[export] 日报 ${r.id} 补排程失败：${(err as Error).message}`);
    }
  }
  const missingPeriod = all<{ id: string; kind: string; period_start: string; period_end: string; content_json: string }>(
    db,
    `SELECT p.id, p.kind, p.period_start, p.period_end, p.content_json FROM period_reports p
      WHERE NOT EXISTS (SELECT 1 FROM export_tasks t WHERE t.ref_id = p.id)`,
  );
  for (const p of missingPeriod) {
    try {
      let rev = 1;
      try {
        rev = (JSON.parse(p.content_json) as { bindings?: { rev?: number } }).bindings?.rev ?? 1;
      } catch { /* 防御：缺 bindings 按 v1 */ }
      const folder = p.kind === 'weekly' ? '周报' : p.kind === 'monthly' ? '月报' : '年报';
      const base = rev > 1 ? `${p.period_start}_${p.period_end}.r${rev}` : `${p.period_start}_${p.period_end}`;
      const taskId = createExportTask(db, { refId: p.id, kind: 'period_report', targetRel: `${folder}/${base}.md`, contentHash: 'pending' });
      await runExportTask(db, taskId, appVersion);
    } catch (err) {
      console.error(`[export] 周期报告 ${p.id} 补排程失败：${(err as Error).message}`);
    }
  }
}

/** H2：用户入口——为已发布但缺导出任务的周期报告补排程并执行（零模型调用）。
 *  任务已存在时直接重试该任务；创建仍失败则明确返回（报告与检查点状态不变）。 */
export async function ensurePeriodExportTask(db: Db, reportId: string, appVersion: string): Promise<ExportRunResult> {
  const row = get<{ id: string; kind: string; period_start: string; period_end: string; content_json: string }>(
    db,
    `SELECT id, kind, period_start, period_end, content_json FROM period_reports WHERE id = ?`,
    reportId,
  );
  if (!row) return { ok: false, status: 'failed', error: '周期报告不存在' };
  const existing = exportTasksFor(db, reportId)[0];
  if (existing) return runExportTask(db, existing.id as string, appVersion);
  let rev = 1;
  try {
    rev = (JSON.parse(row.content_json) as { bindings?: { rev?: number } }).bindings?.rev ?? 1;
  } catch { /* 防御 */ }
  const folder = row.kind === 'weekly' ? '周报' : row.kind === 'monthly' ? '月报' : '年报';
  const base = rev > 1 ? `${row.period_start}_${row.period_end}.r${rev}` : `${row.period_start}_${row.period_end}`;
  let taskId: string;
  try {
    taskId = createExportTask(db, { refId: row.id, kind: 'period_report', targetRel: `${folder}/${base}.md`, contentHash: 'pending' });
  } catch (err) {
    return { ok: false, status: 'failed', error: `导出排程失败：${(err as Error).message}；请稍后重试（不会重新调用模型）` };
  }
  return runExportTask(db, taskId, appVersion);
}

/** 重试：失败任务只重试导出本身（不重新调用模型） */
export async function retryExportTask(db: Db, taskId: string, appVersion: string): Promise<ExportRunResult> {
  return runExportTask(db, taskId, appVersion);
}

/** 列出某引用对象的全部导出任务（最新在前） */
export function exportTasksFor(db: Db, refId: string) {
  return all(
    db,
    `SELECT * FROM export_tasks WHERE ref_id = ? ORDER BY created_at DESC`,
    refId,
  );
}
