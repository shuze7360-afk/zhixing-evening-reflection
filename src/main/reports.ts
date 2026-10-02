// 日报存取：修订另存不覆盖（D-004）；formal 仅在提炼校验成功后为真（不虚报正式日报）。
// 行动确认（明确同意才登记，PRODUCT.md §2）通过"新修订"实现，绝不原地改写。
import { all, get, newId, nowIso, run, withTransaction, type Db } from './db';
import { createExportTask, doneTaskPathConsistent, exportTasksFor, reportToMarkdown, retryExportTask, runExportTask, sha256Hex, type ExportRunResult } from './obsidian';
import type { DailyReportContent } from '../shared/schemas';
import type { AppEvent, ExportTaskRecord, ReportRecord } from '../shared/ipc';

export interface DailyReportRow {
  id: string;
  date: string;
  rev: number;
  source_session_id: string;
  content_json: string;
  model: string | null;
  prompt_version: string | null;
  formal: number;
  superseded_by: string | null;
  created_at: string;
}

export function nextRev(db: Db, date: string): number {
  const row = get<{ m: number | null }>(
    db,
    `SELECT MAX(rev) AS m FROM daily_reports WHERE date = ?`,
    date,
  );
  return (row?.m ?? 0) + 1;
}

export function insertReport(
  db: Db,
  args: {
    date: string;
    sourceSessionId: string;
    content: DailyReportContent;
    model: string | null;
    promptVersion: string | null;
    requestId: string | null;
    formal: boolean;
  },
): DailyReportRow {
  const id = newId();
  const rev = nextRev(db, args.date);
  run(
    db,
    `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, request_id, formal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    args.date,
    rev,
    args.sourceSessionId,
    JSON.stringify(args.content),
    args.model,
    args.promptVersion,
    args.requestId,
    args.formal ? 1 : 0,
    nowIso(),
  );
  return getReport(db, id)!;
}

export function getReport(db: Db, id: string): DailyReportRow | undefined {
  return get<DailyReportRow>(db, `SELECT * FROM daily_reports WHERE id = ?`, id);
}

export function latestReportByDate(db: Db, date: string): DailyReportRow | undefined {
  return get<DailyReportRow>(
    db,
    `SELECT * FROM daily_reports WHERE date = ? ORDER BY rev DESC LIMIT 1`,
    date,
  );
}

export interface ReportWithExport extends DailyReportRow {
  exportTask: ReturnType<typeof exportTasksFor>[number] | null;
}

function withLatestExport(db: Db, r: DailyReportRow): ReportWithExport {
  const tasks = exportTasksFor(db, r.id);
  return { ...r, exportTask: tasks[0] ?? null };
}

export function reportsByDate(db: Db, date: string): ReportWithExport[] {
  return all<DailyReportRow>(
    db,
    `SELECT * FROM daily_reports WHERE date = ? ORDER BY rev DESC`,
    date,
  ).map((r) => withLatestExport(db, r));
}

export function listRecentReports(db: Db, limit = 60): ReportWithExport[] {
  return all<DailyReportRow>(
    db,
    `SELECT * FROM daily_reports ORDER BY date DESC, rev DESC LIMIT ?`,
    limit,
  ).map((r) => withLatestExport(db, r));
}

/** 失败任务重试：只重试导出，不重新调用模型 */
export async function retryReportExport(db: Db, taskId: string, appVersion: string): Promise<ExportRunResult> {
  return retryExportTask(db, taskId, appVersion);
}

// ---------------------------------------------------------------------------
// 渲染进程视图映射（不泄漏数据库内部字段命名）
// ---------------------------------------------------------------------------

export function toReportRecord(r: DailyReportRow): ReportRecord {
  return {
    id: r.id, date: r.date, rev: r.rev, formal: r.formal === 1,
    contentJson: r.content_json, model: r.model, promptVersion: r.prompt_version,
    createdAt: r.created_at, supersededBy: r.superseded_by,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 导出任务行直接来自 SELECT *
export function toExportTaskRecord(t: any, db?: Db): ExportTaskRecord {
  return {
    id: t.id, kind: t.kind, refId: t.ref_id, targetRel: t.target_rel, contentHash: t.content_hash,
    status: t.status, attempts: t.attempts,
    targetUnresolved: t.vault_dir === 'UNRESOLVED', // H3：目标未确认状态透传视图（不靠失败文案猜测）
    // L2：done 任务记录路径一致性透传（需要 db 做轻量核验；无 db 时保守视为不一致，
    // 让页面保留「重新核验导出」入口而不是把错误路径当作已验证报告）
    targetInconsistent: t.status === 'done' && !(db ? doneTaskPathConsistent(db, t) : false),
    lastError: t.last_error ?? null,
    createdAt: t.created_at, updatedAt: t.updated_at, doneAt: t.done_at ?? null,
  };
}

export function viewReports(rows: ReportWithExport[], db?: Db): (ReportRecord & { exportTask: ExportTaskRecord | null })[] {
  return rows.map((r) => ({ ...toReportRecord(r), exportTask: r.exportTask ? toExportTaskRecord(r.exportTask, db) : null }));
}

// ---------------------------------------------------------------------------
// 行动确认与导出排程
// ---------------------------------------------------------------------------

/**
 * S10：创建"当前正式日报"修订——单事务内：替代同日旧正式版 → 插入新修订。
 * 每日期最多一份当前正式日报由部分唯一索引（idx_daily_current，v3）仲裁；
 * 并发写入撞索引 → 明确失败。导出在事务提交后由调用方执行。
 */
export function insertCurrentRevision(
  db: Db,
  args: {
    date: string;
    sourceSessionId: string;
    content: DailyReportContent;
    model: string | null;
    promptVersion: string | null;
    requestId: string | null;
    formal: boolean;
  },
): DailyReportRow {
  // 附加并发合同：同日两个写入者——输的一方重试为新修订（rev 递增），双方记录都保留；
  // 每日期唯一当前正式版由 idx_daily_current 仲裁。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return withTransaction(db, () => {
        const id = newId();
        if (args.formal) {
          run(
            db,
            `UPDATE daily_reports SET superseded_by = ? WHERE date = ? AND formal = 1 AND superseded_by IS NULL`,
            id,
            args.date,
          );
        }
        const rev = nextRev(db, args.date);
        run(
          db,
          `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, request_id, formal, superseded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          id,
          args.date,
          rev,
          args.sourceSessionId,
          JSON.stringify(args.content),
          args.model,
          args.promptVersion,
          args.requestId,
          args.formal ? 1 : 0,
          nowIso(),
        );
        return getReport(db, id)!;
      });
    } catch (err) {
      const msg = String((err as Error).message);
      // W5：UNIQUE（并发撞唯一索引）与 BUSY（写锁争抢）均重试；重试重新读取最新状态（调用方内容不变，
      // 但 rev 分配/替代目标基于事务内重读）。BUSY 重试有界（busy_timeout 5s 已等待）。
      if ((msg.includes('UNIQUE') || msg.includes('database is locked')) && attempt < 4) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error('insertCurrentRevision：并发重试耗尽');
}

/** 排程导出：创建任务并异步执行，经 notify 汇报状态变化 */
export function queueReportExport(
  db: Db,
  report: DailyReportRow,
  appVersion: string,
  notify: (e: AppEvent) => void,
): void {
  const content = JSON.parse(report.content_json) as DailyReportContent;
  const markdown = reportToMarkdown({
    date: report.date, rev: report.rev, content,
    model: report.model, promptVersion: report.prompt_version, appVersion,
  });
  const hash = sha256Hex(Buffer.from(markdown, 'utf8'));
  const base = report.rev > 1 ? `${report.date}.r${report.rev}` : report.date;
  const taskId = createExportTask(db, { refId: report.id, targetRel: `日报/${base}.md`, contentHash: hash });
  queueMicrotask(async () => {
    notify({ type: 'export', taskId, refId: report.id, status: 'running' });
    const r = await runExportTask(db, taskId, appVersion);
    notify({ type: 'export', taskId, refId: report.id, status: r.status, targetRel: r.targetRel, error: r.error });
  });
}

/**
 * 用户确认一条行动候选 → 产生新修订（旧修订标记 superseded）并重新导出。
 * 确认必须来自用户显式操作；这里不提供任何"自动接受"路径。
 * G1 合同（对齐 F3）：单事务内校验 reportId 仍是该日期**当前**修订——旧页面/晚到请求
 * 不得把并发产生的较新内容挤出当前汇总（明确返回 stale 让界面刷新）；重复确认幂等。
 */
export function acceptReportAction(
  db: Db,
  args: { reportId: string; index: number; appVersion: string; notify: (e: AppEvent) => void },
): { ok: true; report: ReportRecord } | { ok: false; error: 'not_found' | 'stale' | 'invalid'; detail?: string } {
  const target = getReport(db, args.reportId);
  if (!target) return { ok: false, error: 'not_found' };
  const idx = Math.trunc(args.index);
  if (!Number.isInteger(idx) || idx < 0) return { ok: false, error: 'invalid' };
  return withTransaction(db, (): { ok: true; report: ReportRecord } | { ok: false; error: 'not_found' | 'stale' | 'invalid'; detail?: string } => {
    // G1：事务内重读当前修订（BEGIN IMMEDIATE 串行化并发确认/新增记录）
    const current = latestReportByDate(db, target.date);
    if (!current || current.id !== args.reportId) {
      // G1 幂等：重复提交（页面未刷新）——旧版上该下标的行动若已被新当前版接受 → 返回当前版
      const tContent = JSON.parse(target.content_json) as DailyReportContent;
      const intended = tContent.action_candidates[idx];
      if (current && intended) {
        const cc = JSON.parse(current.content_json) as DailyReportContent;
        if ((cc.actions_accepted ?? []).some((a) => a.action === intended.action)) {
          return { ok: true, report: toReportRecord(current) };
        }
      }
      return { ok: false, error: 'stale', detail: '该日报已被新版本替代，请刷新后在新版本上确认' };
    }
    const content = JSON.parse(current.content_json) as DailyReportContent;
    if (idx >= content.action_candidates.length) return { ok: false, error: 'invalid' };
    const [accepted] = content.action_candidates.splice(idx, 1);
    // G1 幂等：同一行动已接受过 → 返回当前版，不重复产生修订
    if ((content.actions_accepted ?? []).some((a) => a.action === accepted.action)) {
      return { ok: true, report: toReportRecord(current) };
    }
    const newContent: DailyReportContent = {
      ...content,
      actions_accepted: [
        ...(content.actions_accepted ?? []),
        { action: accepted.action, accepted_at: new Date().toISOString() },
      ],
    };
    // S10/G1：替代在同一事务内完成（insertCurrentRevision 可重入并入本事务）
    const newReport = insertCurrentRevision(db, {
      date: current.date,
      sourceSessionId: current.source_session_id,
      content: newContent,
      model: current.model,
      promptVersion: current.prompt_version,
      requestId: null,
      formal: current.formal === 1,
    });
    queueReportExport(db, newReport, args.appVersion, args.notify);
    return { ok: true, report: toReportRecord(newReport) };
  });
}

/** 修订超期：日报修改产生新修订后，旧修订记录标记 superseded（保留内容） */
export function supersedeOlderRevisions(db: Db, date: string, keepReportId: string): void {
  run(
    db,
    `UPDATE daily_reports SET superseded_by = ? WHERE date = ? AND id != ? AND superseded_by IS NULL`,
    keepReportId,
    date,
    keepReportId,
  );
}

/** W2/F3：用户确认一条模型归纳的感受 → 新修订（feelings_confirmed 追加，ai_notes 移除该项）。
 *  确认必须来自用户显式操作。F3 合同：
 *  - 单事务内校验 reportId 仍是该日期的**当前**修订——旧页面/快速重复点击提交的旧版内容
 *    不得把并发产生的较新内容挤出当前汇总（明确返回 stale 让界面刷新）；
 *  - 幂等：待确认项已确认（或当前内容中已不存在该待核对项且感受已在确认记录中）→
 *    直接返回当前版，不重复产生修订；确认状态只能前进，不能靠显示文本回退。 */
export function confirmReportFeeling(
  db: Db,
  args: { reportId: string; item: string; appVersion: string; notify: (e: AppEvent) => void },
): { ok: true; report: ReportRecord } | { ok: false; error: 'not_found' | 'stale' | 'invalid'; detail?: string } {
  const target = getReport(db, args.reportId);
  if (!target) return { ok: false, error: 'not_found' };
  const item = args.item.trim();
  if (!item) return { ok: false, error: 'invalid' };
  return withTransaction(db, (): { ok: true; report: ReportRecord } | { ok: false; error: 'not_found' | 'stale' | 'invalid'; detail?: string } => {
    // F3：事务内重读当前修订（BEGIN IMMEDIATE 串行化并发确认/新增记录）
    const current = latestReportByDate(db, target.date);
    if (!current || current.id !== args.reportId) {
      return { ok: false, error: 'stale', detail: '该日报已被新版本替代，请刷新后在新版本上确认' };
    }
    const content = JSON.parse(current.content_json) as DailyReportContent & { feelings_confirmed?: string[] };
    const idx = content.ai_notes.findIndex((n) => n === item || n.includes('「' + item + '」'));
    if (idx < 0) {
      // F3 幂等：待核对项已不在当前内容中——若该感受已在确认记录里，视为已完成（不重复修订）
      const m = item.match(/「([^」]+)」/);
      const confirmedText = m ? m[1] : item;
      if ((content.feelings_confirmed ?? []).includes(confirmedText)) {
        return { ok: true, report: toReportRecord(current) };
      }
      return { ok: false, error: 'not_found', detail: '该项不在当前日报的待核对列表中' };
    }
    const [confirmedNote] = content.ai_notes.splice(idx, 1);
    // 从待核对原文提取被确认的感受文本，写入正式 feelings 与确认记录
    const m = confirmedNote.match(/「([^」]+)」/);
    const confirmed = m ? m[1] : item;
    if ((content.feelings_confirmed ?? []).includes(confirmed)) {
      // F3 幂等：已确认过同一感受——不重复追加/不重复产生修订
      return { ok: true, report: toReportRecord(current) };
    }
    const newContent = {
      ...content,
      feelings: [...content.feelings, confirmed],
      ai_notes: content.ai_notes,
      feelings_confirmed: [...(content.feelings_confirmed ?? []), confirmed],
    };
    // 附加并发合同：替代在同一事务内完成（insertCurrentRevision 可重入并入本事务），
    // 不得在事务外补替——避免作废并发产生的新版本。
    const newReport = insertCurrentRevision(db, {
      date: current.date,
      sourceSessionId: current.source_session_id,
      content: newContent,
      model: current.model,
      promptVersion: current.prompt_version,
      requestId: null,
      formal: current.formal === 1,
    });
    queueReportExport(db, newReport, args.appVersion, args.notify);
    return { ok: true, report: toReportRecord(newReport) };
  });
}
