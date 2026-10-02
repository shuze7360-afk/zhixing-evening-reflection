// 备份与恢复（ER-005 / ER-R01 R1+R2 加固）：
// - 备份：VACUUM INTO 暂存库 → 删除凭据字段 → 重整页（二次 VACUUM INTO，旧页内容不可恢复）→ 字节级哨兵校验 → 交付；
//   脱敏失败不交付任何文件。API Key 与机器绑定，恢复后需重新输入。
// - 恢复：结构校验 → 拒绝同源 → 独占检查 → 暂存复制并验证 → 原子替换（失败回滚，旧安全副本保留直到成功）
//   → 任何失败都返回明确错误，调用方不得静默以空库继续。
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newId, nowIso, run, type Db } from './db';
import { SCHEMA_VERSION } from './db';

const CREDENTIAL_KEYS = ['api_key_enc', 'api_key_plain'];

export interface BackupResult {
  ok: boolean;
  file?: string;
  error?: string;
}

function sameFile(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** 备份当前数据库：先在受控暂存库脱敏（凭据行删除 + 重整页），再发布到目标目录 */
export function backupDatabase(db: Db, targetDir: string, userDataDir: string): BackupResult {
  let staging: string | null = null;
  try {
    if (!existsSync(targetDir)) return { ok: false, error: '目标目录不存在' };
    const stamp = nowIso().slice(0, 19).replace(/[:T]/g, '-');
    const file = join(targetDir, `zhixing-backup-${stamp}.db`);
    if (existsSync(file)) return { ok: false, error: '同名备份已存在，请稍后重试' };
    staging = join(targetDir, `zhixing-backup-${stamp}-${newId().slice(0, 8)}.staging.db`);

    // 1) 一致性快照到暂存
    run(db, `VACUUM INTO ?`, staging);

    // 2) 暂存库删除凭据字段
    const staged = new DatabaseSync(staging);
    let credentialValues: string[] = [];
    try {
      credentialValues = staged
        .prepare(`SELECT value FROM settings WHERE key IN ('api_key_enc','api_key_plain') AND value != ''`)
        .all()
        .map((r) => String(r.value));
      staged
        .prepare(`DELETE FROM settings WHERE key IN ('api_key_enc','api_key_plain') OR key LIKE 'api_key%' OR key LIKE '%secret%' OR key LIKE '%token%'`)
        .run();
      const leftover = staged
        .prepare(`SELECT COUNT(*) AS n FROM settings WHERE key IN ('api_key_enc','api_key_plain') OR key LIKE 'api_key%'`)
        .get() as { n: number };
      if (leftover.n !== 0) throw new Error('凭据字段未能完全清除');
    } finally {
      staged.close();
    }

    // 3) 重整页发布：从暂存库 VACUUM INTO 终文件（旧页/空闲页内容不随备份带走）
    const published = new DatabaseSync(staging);
    const finalFile = file;
    try {
      published.exec(`VACUUM INTO '${finalFile.replace(/'/g, "''")}'`);
    } finally {
      published.close();
    }

    // 4) 字节级哨兵校验：凭据密文（及其片段）不得出现在备份文件中
    const bytes = readFileSync(finalFile);
    // N16：多片段校验（头部 + 中段），降低单片段漏检概率
    for (const v of credentialValues) {
      if (v.length < 12) continue;
      const fragments = [v.slice(0, Math.min(24, v.length))];
      if (v.length >= 48) {
        fragments.push(v.slice(Math.floor(v.length / 3), Math.floor(v.length / 3) + 16));
      }
      for (const fragment of fragments) {
        if (bytes.includes(Buffer.from(fragment, 'utf8'))) {
          unlinkSync(finalFile);
          return { ok: false, error: '脱敏校验失败：备份中检测到凭据片段，已拒绝交付' };
        }
      }
    }

    // 5) 元数据说明（不含任何凭据值）
    writeFileSync(
      `${finalFile}.meta.json`,
      JSON.stringify({
        app: 'evening-reflection (知行)',
        schema_version: SCHEMA_VERSION,
        created_at: nowIso(),
        sanitized: true,
        note: '本备份已移除 API Key（加密凭据）。恢复后请在设置中重新输入 Key。',
      }, null, 2),
      'utf8',
    );
    return { ok: true, file: finalFile };
  } catch (err) {
    return { ok: false, error: `备份失败：${(err as Error).message}` };
  } finally {
    // 暂存文件无论成败都不交付（其中可能含凭据页）
    if (staging && existsSync(staging)) {
      try { unlinkSync(staging); } catch { /* 尽力清理 */ }
    }
  }
}

export interface RestoreCheck {
  ok: boolean;
  error?: string;
  counts?: Record<string, number>;
}

/** 恢复前校验：是本应用的库、schema 版本不高于当前；返回统计供用户确认 */
export function validateRestoreSource(sourcePath: string): RestoreCheck {
  try {
    if (!existsSync(sourcePath)) return { ok: false, error: '文件不存在' };
    const probe = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const tables = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      for (const t of ['meta', 'settings', 'sessions', 'messages', 'daily_reports']) {
        if (!names.includes(t)) return { ok: false, error: `不是本应用的备份（缺少表 ${t}）` };
      }
      const meta = probe.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      const version = Number(meta?.value ?? '0');
      if (version > SCHEMA_VERSION) {
        return { ok: false, error: `备份 schema 版本（v${version}）高于当前应用（v${SCHEMA_VERSION}），请先升级应用` };
      }
      const count = (t: string): number =>
        (probe.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      return {
        ok: true,
        counts: {
          会话: count('sessions'),
          消息: count('messages'),
          日报: count('daily_reports'),
          原则卡: count('principle_cards'),
          实验: count('experiments'),
        },
      };
    } finally {
      probe.close();
    }
  } catch (err) {
    return { ok: false, error: `无法读取备份文件：${(err as Error).message}` };
  }
}

/** 写恢复标记：下次启动时生效（见 applyPendingRestore）。拒绝同源。 */
export function requestRestore(userDataDir: string, sourcePath: string): RestoreCheck {
  const currentDb = join(userDataDir, 'zhixing.db');
  if (sameFile(sourcePath, currentDb)) {
    return { ok: false, error: '恢复源与当前数据库是同一个文件，已拒绝（避免自我覆盖导致数据丢失）' };
  }
  const check = validateRestoreSource(sourcePath);
  if (!check.ok) return check;
  writeFileSync(
    join(userDataDir, 'pending-restore.json'),
    JSON.stringify({ from: sourcePath, requested_at: nowIso() }, null, 2),
    'utf8',
  );
  return check;
}

export interface PendingRestoreResult {
  restored: boolean;
  from?: string;
  /** true = 有恢复意图但失败：调用方必须把错误明确呈现，不得静默以空库继续 */
  failed?: boolean;
  error?: string;
}

/** 启动时应用恢复标记（在打开主数据库之前调用）：
 *  同源拒绝 → 独占检查 → 暂存复制并验证 → 原子替换（失败回滚，旧安全副本保留直到成功）。
 *  任何失败：返回 failed=true + error；当前库保持原样（若存在）。 */
export function applyPendingRestore(userDataDir: string): PendingRestoreResult {
  const marker = join(userDataDir, 'pending-restore.json');
  if (!existsSync(marker)) return { restored: false };
  const currentDb = join(userDataDir, 'zhixing.db');
  const beforeRestore = join(userDataDir, 'zhixing.db.before-restore');
  const gate = currentDb + '.restore-gate';
  // W1 协作闸门：存在期间应用/MCP 的 openDb 明确拒绝打开（不与恢复竞争写入）；
  // 成功/回滚（库可用）后释放；库缺失+未解决 = gate 保留（持久阻止空库启动）。
  const acquireGate = (): { ok: boolean; error?: string } => {
    // F1：原子创建——wx（O_EXCL 独占创建）由内核仲裁"已存在即失败"，
    // 消除 exists 检查与写入之间的竞争窗口（两个恢复者同时通过 exists 检查）。
    try {
      writeFileSync(gate, JSON.stringify({ started_at: nowIso() }, null, 2), { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return { ok: false, error: '已有恢复闸门存在（上一次恢复未完成）' };
      return { ok: false, error: (err as Error).message };
    }
  };
  const releaseGate = (): void => {
    try { if (existsSync(gate)) unlinkSync(gate); } catch { /* 尽力 */ }
  };
  // W1：标记解析与分类（在取 gate 之前——损坏标记不取 gate：库存在时应用必须能启动并呈现错误）
  let parsed: { unresolved?: boolean; error?: string; from?: string };
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8')) as { unresolved?: boolean; error?: string; from?: string };
  } catch (err) {
    // 损坏 → 隔离原件 + 写回持久"未解决"标记（后续每次启动持续 failed，直到人工处理）
    let quarantined = '';
    try {
      quarantined = marker + '.corrupt-' + Date.now() + '.json';
      renameSync(marker, quarantined);
    } catch { /* 保留原标记 */ }
    const error = '恢复标记损坏（JSON 不可解析：' + (err as Error).message + '）' + (quarantined ? '，已隔离为 ' + quarantined : '');
    writeFileSync(
      marker,
      JSON.stringify({ unresolved: true, error, requested_at: nowIso() }, null, 2),
      'utf8',
    );
    return { restored: false, failed: true, error: error + '；此状态将持续阻止数据库初始化，直到标记被明确处理' };
  }
  if (parsed.unresolved) {
    return { restored: false, failed: true, error: parsed.error ?? '恢复标记处于未解决状态' };
  }
  const g = acquireGate();
  if (!g.ok) {
    return { restored: false, failed: true, error: g.error };
  }
  // W1 gate 生命周期唯一规则：持有结束时库存在（成功恢复/已回滚/原样保留）→ 释放；
  // 库缺失的失败 → gate 保留（evaluate 层 abort + openDb 层拒绝，持久阻止空库启动，直到明确解决）。
  try {
    const from = (parsed.from ?? '').trim();
    if (!from) {
      // W1：空 from = 持久未解决（写回标记）
      const error = '恢复标记缺少有效的源路径（from 为空）；标记已保留，将持续阻止数据库初始化，直到标记被明确处理';
      writeFileSync(
        marker,
        JSON.stringify({ unresolved: true, error, requested_at: nowIso() }, null, 2),
        'utf8',
      );
      return { restored: false, failed: true, error };
    }
    if (!existsSync(from)) {
      // W1：恢复源消失 = 持久未解决（标记保留，源恢复后可重试）
      const error = '恢复源不存在或已被删除：' + from + '；标记已保留，将持续阻止数据库初始化，直到标记被明确处理';
      writeFileSync(
        marker,
        JSON.stringify({ unresolved: true, error, requested_at: nowIso() }, null, 2),
        'utf8',
      );
      return { restored: false, failed: true, error };
    }
    // 同源拒绝（大小写不敏感比较）
    if (sameFile(from, currentDb)) {
      try { unlinkSync(marker); } catch { /* 保留现状 */ }
      return { restored: false, failed: true, error: '恢复源与当前数据库是同一个文件，已拒绝' };
    }
    // T1：协作排他——取得 BEGIN EXCLUSIVE 并**保持到暂存准备完成**；
    // 其他进程（应用/MCP）在窗口内的写入会因拿不到锁而等待/失败，而不是与恢复竞争。
    let lock: DatabaseSync | null = null;
    const closeLock = (): void => {
      try { lock?.exec('COMMIT'); } catch { /* 尽力 */ }
      try { lock?.close(); } catch { /* 尽力 */ }
      lock = null;
    };
    if (existsSync(currentDb)) {
      try {
        lock = new DatabaseSync(currentDb);
        lock.exec('BEGIN EXCLUSIVE');
      } catch (err) {
        return {
          restored: false, failed: true,
          error: '数据库正被其他进程使用（无法取得排他锁：' + (err as Error).message + '），请关闭应用/MCP 后重试恢复',
        };
      }
    }
    // 暂存复制 + 验证（源可能损坏/被调包，验证独立于请求时）——在持锁期间完成
    const staging = join(userDataDir, `zhixing.restore-staging-${newId().slice(0, 8)}.db`);
    try {
      copyFileSync(from, staging);
      const check = validateRestoreSource(staging);
      if (!check.ok) {
        try { unlinkSync(staging); } catch { /* 清理 */ }
        closeLock();
        return { restored: false, failed: true, error: `恢复源校验失败：${check.error}` };
      }
      // 释放排他锁（Windows：rename 前必须关闭句柄）；此后到 rename 之间的窗口为毫秒级，
      // 且 rename 的目标是刚被排他保护的文件——协作进程在锁期间无法积累写入。
      closeLock();

      // 替换：旧库先落安全副本；发布失败则回滚
      if (existsSync(currentDb)) {
        // S1：checkpoint 必须成功（busy 重试），保证旧安全副本包含 WAL 中未落盘的数据
        let checkpointed = false;
        let lastCpErr = '';
        for (let attempt = 0; attempt < 5 && !checkpointed; attempt++) {
          try {
            const cp = new DatabaseSync(currentDb);
            let busy = -1;
            try {
              const row = cp.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get() as { busy: number };
              busy = Number(row?.busy ?? 0);
            } finally {
              cp.close();
            }
            if (busy === 0) checkpointed = true;
            else lastCpErr = 'WAL checkpoint busy';
          } catch (err) {
            lastCpErr = (err as Error).message;
          }
          if (!checkpointed) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          }
        }
        if (!checkpointed) {
          try { unlinkSync(staging); } catch { /* 清理 */ }
          return {
            restored: false, failed: true,
            error: `数据库正被其他进程使用（checkpoint busy：${lastCpErr}），请关闭应用/MCP 后重试恢复；原数据未受影响`,
          };
        }
        if (existsSync(beforeRestore)) {
          try { unlinkSync(beforeRestore); } catch { /* 保留旧副本优先 */ }
        }
        renameSync(currentDb, beforeRestore);
      }
      try {
        for (const suffix of ['-wal', '-shm']) {
          const side = currentDb + suffix;
          if (existsSync(side)) unlinkSync(side);
        }
        copyFileSync(staging, currentDb);
        const verify = validateRestoreSource(currentDb);
        if (!verify.ok) throw new Error(`替换后验证失败：${verify.error}`);
      } catch (publishErr) {
        // S1：回滚；回滚失败时保留全部恢复材料（staging + marker + before-restore），给出准确状态
        let rollbackOk = false;
        let rollbackErr = '';
        try {
          if (existsSync(currentDb)) unlinkSync(currentDb);
          if (existsSync(beforeRestore)) {
            renameSync(beforeRestore, currentDb);
            rollbackOk = existsSync(currentDb);
          } else if (!existsSync(currentDb)) {
            // 原本就没有旧库：无需回滚
            rollbackOk = true;
          }
        } catch (err) {
          rollbackErr = (err as Error).message;
        }
        if (!rollbackOk) {
          return {
            restored: false, failed: true,
            error: `恢复失败且回滚也失败：${(publishErr as Error).message}；回滚错误：${rollbackErr}。` +
              `原库安全副本在 zhixing.db.before-restore，恢复材料已保留（pending-restore.json 未清除），可手动恢复或重试`,
          };
        }
        throw publishErr;
      }
      try { unlinkSync(staging); } catch { /* 清理 */ }
      try { unlinkSync(marker); } catch { /* 保留现状 */ }
      return { restored: true, from };
    } catch (err) {
      try { if (existsSync(staging)) unlinkSync(staging); } catch { /* 清理 */ }
      closeLock(); // T1：任何失败路径都不得泄漏排他锁（否则同进程后续恢复永远拿不到锁）
      return { restored: false, failed: true, error: `恢复未能完成：${(err as Error).message}（原数据未受影响或已回滚）` };
    }
  } catch (err) {
    return { restored: false, failed: true, error: `恢复未能完成：${(err as Error).message}` };
  } finally {
    if (existsSync(currentDb)) releaseGate();
  }
}

// ---------------------------------------------------------------------------
// 启动决策（ER-R01 第二轮 B1）：把"恢复结果→启动行为"做成纯函数，接线在 index.ts。
// ---------------------------------------------------------------------------

export interface StartupRestoreOutcome {
  action: 'none' | 'continue' | 'abort';
  error?: string;
  from?: string;
}

/** 启动时评估恢复标记：
 *  - 恢复成功 → continue（带 from）；
 *  - 恢复失败但当前库仍在（已回滚）→ continue 并携带错误（调用方必须向用户呈现，不得无声）；
 *  - 恢复失败且当前库不存在 → abort（绝不允许静默以空库继续运行）。 */
export function evaluateStartupRestore(userDataDir: string): StartupRestoreOutcome {
  const r = applyPendingRestore(userDataDir);
  if (r.restored) return { action: 'continue', from: r.from };
  if (r.failed) {
    const dbExists = existsSync(join(userDataDir, 'zhixing.db'));
    return {
      action: dbExists ? 'continue' : 'abort',
      error: r.error,
    };
  }
  return { action: 'none' };
}
