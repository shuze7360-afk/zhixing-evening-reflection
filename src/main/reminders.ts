// 提醒决策（docs/ARCHITECTURE.md §9）：纯逻辑，便于离线测试。
// 纪律：一个自然日最多一次尝试；已在当天完成正式日报或有进行中的会话则不打扰；
// 窗口外不提醒；发出尝试 ≠ 用户已看到（只记录尝试）；不补发历史、不唤醒电脑（由调用方保证）。
import { get, run, newId, nowIso, type Db } from './db';

export interface ReminderConfig {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export type ReminderDecision =
  | { action: 'none'; reason: 'disabled' | 'outside_window' | 'already_attempted' | 'already_reflected' }
  | { action: 'notify' };

export function localDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function decideReminder(db: Db, now: Date, cfg: ReminderConfig): ReminderDecision {
  if (!cfg.enabled) return { action: 'none', reason: 'disabled' };
  const date = localDateOf(now);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(cfg.start);
  const end = minutesOf(cfg.end);
  if (cur < start || cur > end) return { action: 'none', reason: 'outside_window' };

  // R9：原子认领取代检查+写入——INSERT OR IGNORE 由 reminders.date 唯一索引仲裁，
  // 两个进程（应用/MCP/第二实例）只有一个能认领当天。
  const claimed = claimReminderDay(db, date, now, 'notification');
  if (!claimed) return { action: 'none', reason: 'already_attempted' };
  // 认领成功后再核对业务条件（已复盘/进行中）——不满足则释放认领
  const reported = get(
    db,
    `SELECT id FROM daily_reports WHERE date = ? AND formal = 1 LIMIT 1`,
    date,
  );
  if (reported) {
    releaseReminderDay(db, date);
    return { action: 'none', reason: 'already_reflected' };
  }
  const activeSession = get(
    db,
    `SELECT id FROM sessions WHERE date = ? AND status = 'active' AND kind = 'chat' LIMIT 1`,
    date,
  );
  if (activeSession) {
    releaseReminderDay(db, date);
    return { action: 'none', reason: 'already_reflected' };
  }
  return { action: 'notify' };
}



/** 记录"已尝试"（原子）：唯一索引保证跨进程一天只成功一次；返回是否本进程认领成功 */
export function claimReminderDay(db: Db, date: string, now: Date, channel: string): boolean {
  try {
    const r = run(
      db,
      `INSERT INTO reminders (id, date, sent_at, seen, channel) VALUES (?, ?, ?, 0, ?)`,
      newId(),
      date,
      nowIso(),
      channel,
    );
    return Number(r.changes) > 0;
  } catch {
    return false; // UNIQUE 冲突 = 别的进程已认领
  }
}

/** 释放认领（业务条件不满足时回退，当天仍可再提醒） */
export function releaseReminderDay(db: Db, date: string): void {
  run(db, `DELETE FROM reminders WHERE date = ?`, date);
}

/** 兼容旧调用：记录尝试（内部走原子认领） */
export function recordAttempt(db: Db, now: Date, channel: string): void {
  claimReminderDay(db, localDateOf(now), now, channel);
}

export function hasAttempted(db: Db, date: string): boolean {
  return !!get(db, `SELECT id FROM reminders WHERE date = ?`, date);
}
