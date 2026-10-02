// 最小实验（docs/PRODUCT.md §5）：三个假设 → 选最关键 → 动作/投入/周期/指标/继续与停止条件
// → 明天能开始的第一步 → 按实际结果调整判断。
// 约束：周期 ≤7 天；同时最多一个进行中；不要求每天创建。
import { all, get, newId, nowIso, run, withTransaction, type Db } from './db';
import type { ExperimentRecord } from '../shared/ipc';
import type { ExperimentCreateInput } from '../shared/schemas';

export type CreateResult =
  | { ok: true; experiment: ExperimentRecord }
  | { ok: false; error: 'active_exists' | 'invalid'; detail?: string };

export interface DraftOptions {
  origin?: 'mcp' | 'import';
}

/** 草稿实验（ER-R01 R10）：status='planned'，不占用"单进行中"约束；
 *  应用界面确认后经 startExperimentDraft 进入 running（记录确认时间）。 */
export function createExperimentDraft(db: Db, args: ExperimentCreateInput, opts?: DraftOptions): CreateResult {
  const id = newId();
  const started = nowIso();
  run(
    db,
    `INSERT INTO experiments (id, hypothesis, action, invest, period_days, metric, continue_rule, stop_rule, status, first_step, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
    id,
    JSON.stringify({ hypotheses: args.hypotheses, key_index: args.keyIndex }),
    args.action,
    args.invest ?? '',
    args.periodDays,
    args.metric ?? '',
    args.continueRule ?? '',
    args.stopRule ?? '',
    args.firstStep + (opts?.origin === 'mcp' ? '（来源：MCP 草稿）' : ''),
    started,
  );
  return { ok: true, experiment: mapRow(get(db, `SELECT * FROM experiments WHERE id = ?`, id)!) };
}

/** 草稿启动（仅应用界面路径）：planned → running，受单进行中唯一索引仲裁；记录确认时间 */
export function startExperimentDraft(db: Db, id: string): CreateResult {
  const exp = get(db, `SELECT status FROM experiments WHERE id = ?`, id);
  if (!exp) return { ok: false, error: 'invalid', detail: '实验不存在' };
  if (exp.status !== 'planned') return { ok: false, error: 'invalid', detail: '仅草稿可启动' };
  const active = get(db, `SELECT id FROM experiments WHERE status = 'running'`);
  if (active) return { ok: false, error: 'active_exists', detail: '同时最多一个进行中的实验' };
  try {
    run(
      db,
      `UPDATE experiments SET status = 'running', created_at = ?, conclusion = NULL WHERE id = ? AND status = 'planned'`,
      nowIso(),
      id,
    );
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      return { ok: false, error: 'active_exists', detail: '同时最多一个进行中的实验（并发启动被数据库约束拒绝）' };
    }
    throw err;
  }
  return { ok: true, experiment: mapRow(get(db, `SELECT * FROM experiments WHERE id = ?`, id)!) };
}

export function createExperiment(db: Db, args: ExperimentCreateInput): CreateResult {
  const active = get(db, `SELECT id FROM experiments WHERE status = 'running'`);
  if (active) return { ok: false, error: 'active_exists', detail: '同时最多一个进行中的实验' };
  try {
    return insertExperiment(db, args);
  } catch (err) {
    // R9：并发创建撞唯一索引（idx_experiments_single_running）→ 明确拒绝
    if (String((err as Error).message).includes('UNIQUE')) {
      return { ok: false, error: 'active_exists', detail: '同时最多一个进行中的实验（并发创建被数据库约束拒绝）' };
    }
    throw err;
  }
}

function insertExperiment(db: Db, args: ExperimentCreateInput): CreateResult {

  const id = newId();
  const started = nowIso();
  run(
    db,
    `INSERT INTO experiments (id, hypothesis, action, invest, period_days, metric, continue_rule, stop_rule, status, first_step, created_at, ended_at, conclusion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL)`,
    id,
    JSON.stringify({ hypotheses: args.hypotheses, key_index: args.keyIndex }),
    args.action,
    args.invest ?? '',
    args.periodDays,
    args.metric ?? '',
    args.continueRule ?? '',
    args.stopRule ?? '',
    args.firstStep,
    started,
  );
  return { ok: true, experiment: mapRow(get(db, `SELECT * FROM experiments WHERE id = ?`, id)!) };
}

/** 记录观察（ER-R01 R9）：条件写入——仅当实验仍是 running 时插入，检查实际修改行数；
 *  与并发"结束实验"竞争时，输的一方明确失败。 */
export function addObservation(db: Db, id: string, text: string): { ok: boolean; detail?: string } {
  const t = text.trim();
  if (!t || t.length > 500) return { ok: false, detail: '观察内容为空或过长' };
  return withTransaction(db, () => {
    const exp = get(db, `SELECT status FROM experiments WHERE id = ?`, id);
    if (!exp) return { ok: false, detail: '实验不存在' };
    if (exp.status !== 'running') return { ok: false, detail: '实验已结束，不能再补观察' };
    run(
      db,
      `INSERT INTO experiment_observations (id, experiment_id, text, created_at) VALUES (?, ?, ?, ?)`,
      newId(),
      id,
      t,
      nowIso(),
    );
    return { ok: true };
  });
}

/** 结束实验：记录结果与结论（根据实际结果调整判断），周期外结束同样允许（提前止损是理性） */
export function concludeExperiment(
  db: Db,
  id: string,
  args: { outcome: string; conclusion: string },
): { ok: boolean; detail?: string } {
  const exp = get(db, `SELECT id, status FROM experiments WHERE id = ?`, id);
  if (!exp) return { ok: false, detail: '实验不存在' };
  if (exp.status !== 'running') return { ok: false, detail: '实验已结束' };
  const outcome = args.outcome.trim();
  const conclusion = args.conclusion.trim();
  if (!outcome || outcome.length > 2000 || !conclusion || conclusion.length > 2000) {
    return { ok: false, detail: '结果与结论必须非空且不过长' };
  }
  // 条件写入（R9）：并发结束只成功一次（第二次 UPDATE 命中 0 行）
  const r = run(
    db,
    `UPDATE experiments SET status = 'concluded', ended_at = ?, conclusion = ? WHERE id = ? AND status = 'running'`,
    nowIso(),
    JSON.stringify({ outcome, conclusion }),
    id,
  );
  if (Number(r.changes) === 0) return { ok: false, detail: '实验已被并发结束或不存在' };
  return { ok: true };
}

export function listExperiments(db: Db): ExperimentRecord[] {
  const rows = all<DbExp>(db, `SELECT * FROM experiments ORDER BY created_at DESC`).map(mapRow);
  const obs = all<{ experiment_id: string; text: string; created_at: string }>(
    db,
    `SELECT experiment_id, text, created_at FROM experiment_observations ORDER BY created_at`,
  );
  for (const r of rows) {
    r.observations = obs
      .filter((o) => o.experiment_id === r.id)
      .map((o) => ({ text: o.text, createdAt: o.created_at }));
  }
  return rows;
}

export function activeExperiment(db: Db): ExperimentRecord | null {
  const row = get<DbExp>(db, `SELECT * FROM experiments WHERE status = 'running' ORDER BY created_at DESC`);
  if (!row) return null;
  const r = mapRow(row);
  r.observations = all<{ experiment_id: string; text: string; created_at: string }>(
    db,
    `SELECT experiment_id, text, created_at FROM experiment_observations WHERE experiment_id = ? ORDER BY created_at`,
    row.id,
  ).map((o) => ({ text: o.text, createdAt: o.created_at }));
  return r;
}

interface DbExp {
  id: string; hypothesis: string; action: string; invest: string | null; period_days: number;
  metric: string | null; continue_rule: string | null; stop_rule: string | null; status: string;
  first_step: string; created_at: string; ended_at: string | null; conclusion: string | null;
}

function mapRow(r: DbExp): ExperimentRecord {
  let hypotheses: string[] = [];
  let keyIndex = 0;
  let conclusion: { outcome: string; conclusion: string } | null = null;
  try {
    const h = JSON.parse(r.hypothesis) as { hypotheses: string[]; key_index: number };
    hypotheses = h.hypotheses;
    keyIndex = h.key_index;
  } catch { /* 旧数据防御 */ }
  try {
    if (r.conclusion) conclusion = JSON.parse(r.conclusion);
  } catch { /* 防御 */ }
  return {
    id: r.id,
    hypotheses,
    keyIndex,
    action: r.action,
    invest: r.invest ?? '',
    periodDays: r.period_days,
    metric: r.metric ?? '',
    continueRule: r.continue_rule ?? '',
    stopRule: r.stop_rule ?? '',
    status: r.status as ExperimentRecord['status'],
    firstStep: r.first_step,
    startedAt: r.created_at,
    endedAt: r.ended_at,
    conclusion,
    observations: [],
  };
}
