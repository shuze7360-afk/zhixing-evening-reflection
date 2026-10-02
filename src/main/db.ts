// SQLite（node:sqlite 内置模块，见 DECISIONS.md D-015）。
// 仅主进程使用；数据库文件位于 userData（不入仓库）。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 4; // v4（F6：v3 库中 NULL 目标的导出任务幂等回填 UNRESOLVED；含 v3/v2 约束）

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function openDb(dbPath: string): Db {
  // W1：协作恢复闸门——恢复流程期间（gate 文件存在）应用/MCP 打开数据库会被明确拒绝，
  // 而不是与恢复竞争写入；gate 由恢复流程在成功/回滚后释放，失败时保留（持久阻止）。
  const gate = dbPath + '.restore-gate';
  if (existsSync(gate)) {
    throw new Error(
      '数据库恢复正在进行或未完成（存在 ' + gate + '）。在恢复问题解决前拒绝打开数据库；' +
      '如确认无需恢复，请手动删除该 gate 文件。',
    );
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;'); // W5：统一等待策略（桌面连接与 MCP 一致）
  gatePathByDb.set(db, dbPath + '.restore-gate'); // F1：登记该连接的恢复闸门路径
  try {
    migrate(db, dbPath);
  } catch (err) {
    // T2：迁移失败必须关闭连接并保留准确错误（不得留下半开的句柄或含糊报错）
    try { db.close(); } catch { /* 尽力 */ }
    throw new Error(`数据库迁移失败（${dbPath}）：${(err as Error).message}`);
  }
  return db;
}

// F1：恢复闸门必须约束**每一次写入**，而不只是新连接——常驻 MCP 在恢复开始前已持有连接，
// 仅 openDb 检查无法阻止它在恢复（暂存/checkpoint/替换）期间提交写入。
// 所有写入都经由 run()/withTransaction()（应用与 MCP 共同路径），在此统一拒绝。
// 经 openDb 建立的连接（应用与 MCP 的唯一合法途径）在创建时登记 gate 路径。
const gatePathByDb = new WeakMap<Db, string>();

/** F1：恢复期间（gate 存在）显式拒绝既有连接的写入——覆盖暂存、checkpoint、替换全阶段。
 *  错误可恢复：gate 释放（恢复成功/回滚）后同一连接即可继续写入。 */
export function assertNotInRestore(db: Db): void {
  const gate = gatePathByDb.get(db);
  if (gate && existsSync(gate)) {
    throw new Error(
      '数据库恢复正在进行或未完成（restore-gate 存在）：写入已被拒绝以保护恢复过程；' +
        '请等待恢复解决后重试，或重启客户端获取新状态',
    );
  }
}

function migrate(db: Db, dbPath: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,                -- chat | short
      phase TEXT NOT NULL,               -- narrate|followup|wrapup|deep|refining|refine_failed|closed
      followup_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,              -- active | closed
      prompt_version TEXT NOT NULL,
      model TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date, status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,                -- user | assistant | system-note
      kind TEXT NOT NULL DEFAULT 'text', -- text | skip-note | feedback
      content TEXT NOT NULL,
      request_id TEXT,
      state TEXT NOT NULL DEFAULT 'verified',  -- unsent|running|unknown|verified|failed
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS model_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      kind TEXT NOT NULL,                -- chat | refine | fix | test
      prompt_version TEXT,
      status TEXT NOT NULL,              -- unsent|running|unknown|verified|failed
      payload_summary TEXT,              -- 摘要（不含消息全文，不含密钥）
      error_class TEXT,
      error_message TEXT,
      raw_response TEXT,                 -- 仅提炼失败时保留草稿原文
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      pre_hold_cny REAL NOT NULL,        -- 调用前保守预占（D-012）
      in_tokens INTEGER,
      out_tokens INTEGER,
      actual_cny REAL,
      estimated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,              -- held | settled | unknown | refunded
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_request ON usage(request_id);

    CREATE TABLE IF NOT EXISTS daily_reports (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      rev INTEGER NOT NULL,              -- 修订另存，不覆盖（D-004）
      source_session_id TEXT NOT NULL,
      content_json TEXT NOT NULL,
      model TEXT,
      prompt_version TEXT,
      request_id TEXT,
      formal INTEGER NOT NULL DEFAULT 0, -- 收束校验成功才置 1
      superseded_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_date ON daily_reports(date, rev);

    CREATE TABLE IF NOT EXISTS export_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,                -- daily_report
      ref_id TEXT NOT NULL,
      target_rel TEXT NOT NULL,          -- 相对 Vault 根（正向斜杠）
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,              -- pending | running | done | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      vault_dir TEXT,                    -- 创建时锁定的目标 Vault（重试不漂移）
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_export_ref ON export_tasks(ref_id);

    -- 前瞻表：ER-003/004 填充（先建结构，避免后续迁移）
    CREATE TABLE IF NOT EXISTS source_snapshots (
      id TEXT PRIMARY KEY, url TEXT, fetched_at TEXT, content_hash TEXT, body TEXT
    );
    CREATE TABLE IF NOT EXISTS principle_cards (
      id TEXT PRIMARY KEY, quote_en TEXT, source_url TEXT, snapshot_id TEXT,
      position TEXT, explanation_cn TEXT, boundary TEXT, enabled INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'import', created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY, hypothesis TEXT, action TEXT, invest TEXT, period_days INTEGER,
      metric TEXT, continue_rule TEXT, stop_rule TEXT, status TEXT NOT NULL DEFAULT 'planned',
      first_step TEXT, created_at TEXT, ended_at TEXT, conclusion TEXT
    );
    CREATE TABLE IF NOT EXISTS experiment_observations (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS period_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, period_start TEXT, period_end TEXT,
      content_json TEXT NOT NULL, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, sent_at TEXT, seen INTEGER NOT NULL DEFAULT 0, channel TEXT
    );
  `);

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;

  // v1 → v2（ER-R01 R9）：先去重既有数据，再加唯一索引（不破坏旧库）。
  // 全新库（无 meta 行）直接以最新形态创建，不需要任何数据修复。
  if (row && current < 2) {
    // 1) 多个 running 实验：保留最早一个，其余改 concluded（留痕，不删数据）
    db.exec(`
      UPDATE experiments SET status = 'concluded', ended_at = COALESCE(ended_at, datetime('now')),
        conclusion = COALESCE(conclusion, '{"outcome":"迁移去重：与更早的进行中实验冲突","conclusion":"请在应用中重新确认"}')
      WHERE status = 'running' AND id NOT IN (
        SELECT id FROM experiments WHERE status = 'running' ORDER BY created_at LIMIT 1
      )
    `);
    // 3) 提醒按日去重（唯一索引在公共段创建）
    db.exec(`DELETE FROM reminders WHERE id NOT IN (
      SELECT id FROM reminders r1
      WHERE NOT EXISTS (SELECT 1 FROM reminders r2 WHERE r2.date = r1.date AND r2.id < r1.id)
    )`);
  }

  // v2 → v3（S10/T2）：同日多份"当前正式日报"去重——每个日期按 rev DESC、id ASC 确定性选一个
  // keeper，其余全部指向 keeper（同 rev 并列同样处理）；全部变换 + 索引 + 版本号在同一事务内，
  // 失败整体回滚；迁移前先落一份前置备份（保留全部旧记录，绝不删用户内容）。
  if (row && current < SCHEMA_VERSION) {
    // T2：升级前先备份（保留全部旧记录）
    const backupPath = `${dbPath}.pre-migrate-v${SCHEMA_VERSION}.backup`;
    if (!existsSync(backupPath)) {
      db.prepare(`VACUUM INTO ?`).run(backupPath);
    }
    db.exec('BEGIN');
    try {
      db.exec(`
        UPDATE daily_reports SET superseded_by = (
          SELECT k.id FROM daily_reports k
           WHERE k.date = daily_reports.date AND k.formal = 1 AND k.superseded_by IS NULL
           ORDER BY k.rev DESC, k.id ASC LIMIT 1
        )
        WHERE formal = 1 AND superseded_by IS NULL
          AND id != (
            SELECT k.id FROM daily_reports k
             WHERE k.date = daily_reports.date AND k.formal = 1 AND k.superseded_by IS NULL
             ORDER BY k.rev DESC, k.id ASC LIMIT 1
          )
      `);
      // T5：原则卡来源类型独立持久字段（不得从显示文本猜测）；导出任务绑定创建时的 Vault
      const pcCols = (db.prepare(`PRAGMA table_info(principle_cards)`).all() as { name: string }[]).map((c) => c.name);
      if (!pcCols.includes('origin')) {
        db.exec(`ALTER TABLE principle_cards ADD COLUMN origin TEXT NOT NULL DEFAULT 'import'`);
        db.exec(`
          UPDATE principle_cards SET origin = CASE
            WHEN id LIKE 'naval-batch1:%' THEN 'book'
            WHEN snapshot_id IS NOT NULL THEN 'book'
            WHEN source_url IS NOT NULL AND source_url != '' THEN 'quote'
            ELSE 'suggestion'
          END
          WHERE origin = 'import'
        `);
      }
      const etCols = (db.prepare(`PRAGMA table_info(export_tasks)`).all() as { name: string }[]).map((c) => c.name);
      if (!etCols.includes('vault_dir')) {
        db.exec(`ALTER TABLE export_tasks ADD COLUMN vault_dir TEXT`);
      }
      // W6/F6：旧任务无历史 Vault 记录——不能悄悄采用后来的设置；标记 UNRESOLVED，
      // 重试时明确报错让用户选择目标（用户选择后持久化到任务记录）。
      // F6：回填必须覆盖"列已存在但值为 NULL"（v3 库，第四轮前发布的数据）——
      // 放在列检查分支之外，幂等执行，任何旧版本升级到当前版都会补齐。
      db.exec(`UPDATE export_tasks SET vault_dir = 'UNRESOLVED' WHERE vault_dir IS NULL`);
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw err;
    }
  }

  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  } else if (current < SCHEMA_VERSION) {
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
  }

  // 唯一约束幂等创建（全新库/升级库统一）：去重事务先于本段执行，不会因重复失败
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_single_running
           ON experiments(status) WHERE status = 'running'`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_date ON reminders(date)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_current
           ON daily_reports(date) WHERE superseded_by IS NULL AND formal = 1`);
}

// ---------------------------------------------------------------------------
// 轻量查询助手（node:sqlite 同步 API 之上）
// ---------------------------------------------------------------------------

export function get<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  ...params: (string | number | null)[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  ...params: (string | number | null)[]
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(
  db: Db,
  sql: string,
  ...params: (string | number | null)[]
): { changes: number | bigint } {
  assertNotInRestore(db); // F1：恢复期间拒绝一切写入（含恢复前已打开的连接）
  return db.prepare(sql).run(...params);
}

// 事务重入计数（同连接嵌套使用时并入外层事务——W5 多进程修复中 startShort 与
// insertCurrentRevision 嵌套产生"transaction within a transaction"，SQLite 无嵌套事务）
const txDepth = new WeakMap<Db, number>();

/** 事务助手：BEGIN IMMEDIATE 获取写锁，保证检查+写入的原子性（ER-R01 R5/R9）。
 *  可重入：嵌套调用并入外层事务（最外层提交），避免 "transaction within a transaction"。
 *  F1：最外层入口同样拒绝恢复期间的写入。 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    // 已在事务内：直接执行（由最外层提交）
    return fn();
  }
  assertNotInRestore(db);
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    txDepth.set(db, 0);
    return r;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    txDepth.set(db, 0);
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}
