// 预算机制（docs/DECISIONS.md D-012、D-016）：
// 调用前保守预占 → 返回 usage 后按实际结算；结果未知保留预占；确定性失败（未消耗）退款；
// 重试、格式修复、连接测试与（未来的）后台报告共用同一预算；超限暂停模型调用但允许本地记录。
import { all, get, newId, nowIso, run, withTransaction, type Db } from './db';

export interface PriceConfig {
  inCnyPerMtok: number;
  outCnyPerMtok: number;
}

export type UsageKind = 'chat' | 'refine' | 'fix' | 'test';

/** 当月已占用金额：held/unknown 计预占，settled 计实际，refunded 不计 */
export function effectiveSpendCny(db: Db): number {
  const row = get<{ s: number | null }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN status IN ('held','unknown') THEN pre_hold_cny
                               WHEN status = 'settled' THEN actual_cny ELSE 0 END), 0) AS s
       FROM usage
      WHERE status IN ('held','unknown','settled')
        AND substr(created_at, 1, 7) = ?`,
    new Date().toISOString().slice(0, 7),
  );
  return row?.s ?? 0;
}

/** 界面展示用（两位小数）；预算判断一律使用 effectiveSpendCny 的未舍入值（ER-R01 R5） */
export function displaySpendCny(db: Db): number {
  return round2(effectiveSpendCny(db));
}

/** 预占金额：输入、输出分别按各自单价计算（ER-R01 R5） */
export function holdAmountCny(
  estInTokens: number,
  estOutTokens: number,
  price: PriceConfig,
): number {
  return Math.max(
    0.005,
    round4((estInTokens / 1_000_000) * price.inCnyPerMtok + (estOutTokens / 1_000_000) * price.outCnyPerMtok),
  );
}

export interface ReserveResult {
  allowed: boolean;
  usageId?: string;
  holdCny: number;
  spendCny: number;
  limitCny: number;
}

/** 统一"检查并预占"入口（ER-R01 R5）：BEGIN IMMEDIATE 串行化，避免并发请求共同突破剩余额度。
 *  所有模型调用（聊天/提炼/修复/周期报告/测试连接）必须经此入口，不得绕过。 */
export function reserve(
  db: Db,
  args: { requestId: string; kind: UsageKind; estInTokens: number; maxOutTokens: number; price: PriceConfig; limitCny: number },
  /** S2：同事务内完成的后续写入（如 model_requests 行），失败整体回滚 */
  onReserved?: () => void,
): ReserveResult {
  const holdCny = holdAmountCny(args.estInTokens, args.maxOutTokens, args.price);
  return withTransaction(db, () => {
    const spendCny = effectiveSpendCny(db);
    if (spendCny + holdCny > args.limitCny + 1e-9) {
      return { allowed: false, holdCny, spendCny, limitCny: args.limitCny };
    }
    const usageId = newId();
    run(
      db,
      `INSERT INTO usage (id, request_id, kind, pre_hold_cny, status, created_at)
       VALUES (?, ?, ?, ?, 'held', ?)`,
      usageId,
      args.requestId,
      args.kind,
      holdCny,
      nowIso(),
    );
    onReserved?.();
    return { allowed: true, usageId, holdCny, spendCny, limitCny: args.limitCny };
  });
}

export interface BudgetCheck {
  allowed: boolean;
  spendCny: number;
  limitCny: number;
  holdCny: number;
}

/** 预占前检查：projected = 已占用 + 本次预占 是否超限 */
export function checkBudget(
  db: Db,
  limitCny: number,
  holdCny: number,
): BudgetCheck {
  const spendCny = effectiveSpendCny(db);
  return {
    allowed: spendCny + holdCny <= limitCny + 1e-9,
    spendCny,
    limitCny,
    holdCny,
  };
}

/** 预占：输入按字符数保守估算（上限≈tokens），输出按任务类型上限（shared/config） */
export function preHold(
  db: Db,
  requestId: string,
  kind: UsageKind,
  estInTokens: number,
  estOutTokens: number,
  price: PriceConfig,
): { usageId: string; holdCny: number } {
  const holdCny = Math.max(
    0.005,
    round4((estInTokens / 1_000_000) * price.inCnyPerMtok + (estOutTokens / 1_000_000) * price.outCnyPerMtok),
  );
  const usageId = newId();
  run(
    db,
    `INSERT INTO usage (id, request_id, kind, pre_hold_cny, status, created_at)
     VALUES (?, ?, ?, ?, 'held', ?)`,
    usageId,
    requestId,
    kind,
    holdCny,
    nowIso(),
  );
  return { usageId, holdCny };
}

export interface UsageTokens {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 结算：优先实际 usage；无 usage 时按估算 tokens 结算并标记 estimated（D-016） */
export function settle(
  db: Db,
  usageId: string,
  tokens: UsageTokens | null,
  estimatedInTokens: number,
  estimatedOutTokens: number,
  price: PriceConfig,
): void {
  const inTok = tokens?.prompt_tokens ?? estimatedInTokens;
  const outTok = tokens?.completion_tokens ?? estimatedOutTokens;
  const estimated = tokens ? 0 : 1;
  const actual = round4(
    (inTok / 1_000_000) * price.inCnyPerMtok +
      (outTok / 1_000_000) * price.outCnyPerMtok,
  );
  run(
    db,
    `UPDATE usage SET in_tokens = ?, out_tokens = ?, actual_cny = ?, estimated = ?, status = 'settled', settled_at = ?
      WHERE id = ?`,
    Math.round(inTok),
    Math.round(outTok),
    actual,
    estimated,
    nowIso(),
    usageId,
  );
}

/** 确定性失败（未消耗 tokens）：退回预占 */
export function refund(db: Db, usageId: string): void {
  run(db, `UPDATE usage SET status = 'refunded', settled_at = ? WHERE id = ?`, nowIso(), usageId);
}

/** 结果未知（超时/中断）：保留预占（D-012） */
export function keepHold(db: Db, usageId: string): void {
  run(db, `UPDATE usage SET status = 'unknown' WHERE id = ?`, usageId);
}

/** 某请求的预占记录（结算/退款用） */
export function findHeldUsage(db: Db, requestId: string): { id: string } | undefined {
  return get<{ id: string }>(
    db,
    `SELECT id FROM usage WHERE request_id = ? AND status = 'held' ORDER BY created_at DESC LIMIT 1`,
    requestId,
  );
}

/** 最近若干条用量（设置页展示） */
export function recentUsage(db: Db, limit = 10) {
  return all(
    db,
    `SELECT kind, status, pre_hold_cny, actual_cny, in_tokens, out_tokens, estimated, created_at
       FROM usage ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
