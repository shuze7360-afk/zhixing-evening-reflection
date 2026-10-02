// 思想库：原则卡与来源快照（docs/PRODUCT.md §4）。
// 纪律：原文引用必须与来源快照匹配；中文归纳一律是"解读"；新增卡须经用户确认才启用。
// 首批原则自 resources/principles/ 幂等种子化；用户导入的内容为草稿，启用前不参与反馈。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, newId, nowIso, run, sha256Hex, type Db } from './db';
import type { PrincipleRecord } from '../shared/ipc';

interface BatchCard {
  key: string;
  theme: string;
  quote_en: string;
  source_url: string;
  position: string;
  snapshot: string;
  interpretation_cn: string;
  boundary_cn: string;
}

interface BatchFile {
  batch: string;
  fetched_at: string;
  cards: BatchCard[];
}

interface SnapshotFile {
  batch: string;
  fetched_at: string;
  snapshots: { id: string; chapter: string; url: string; quotes: { text: string; position: string }[] }[];
}

/** 启动时幂等种子化：按 batch+key 判重，快照按内容 hash 判重 */
export function seedPrinciples(db: Db, baseDir: string): { inserted: number; skipped: number } {
  let batch: BatchFile;
  let snaps: SnapshotFile;
  try {
    batch = JSON.parse(readFileSync(join(baseDir, 'principles', 'naval-batch1.json'), 'utf8'));
    snaps = JSON.parse(readFileSync(join(baseDir, 'principles', 'snapshots', 'naval-batch1-snapshots.json'), 'utf8'));
  } catch {
    return { inserted: 0, skipped: 0 }; // 资源缺失不致命
  }
  let inserted = 0;
  let skipped = 0;

  for (const snap of snaps.snapshots) {
    const body = JSON.stringify(snap);
    const hash = sha256Hex(body);
    const exists = get(db, `SELECT id FROM source_snapshots WHERE id = ?`, snap.id);
    if (!exists) {
      run(
        db,
        `INSERT INTO source_snapshots (id, url, fetched_at, content_hash, body) VALUES (?, ?, ?, ?, ?)`,
        snap.id,
        snap.url,
        snaps.fetched_at,
        hash,
        body,
      );
    }
  }

  for (const c of batch.cards) {
    const exists = get(db, `SELECT id FROM principle_cards WHERE id = ?`, `${batch.batch}:${c.key}`);
    if (exists) {
      skipped++;
      continue;
    }
    run(
      db,
      `INSERT INTO principle_cards (id, quote_en, source_url, snapshot_id, position, explanation_cn, boundary, enabled, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'book', ?)`,
      `${batch.batch}:${c.key}`,
      c.quote_en,
      c.source_url,
      c.snapshot,
      `[${c.theme}] ${c.position}`,
      c.interpretation_cn,
      c.boundary_cn,
      nowIso(),
    );
    inserted++;
  }
  return { inserted, skipped };
}

export function listPrinciples(db: Db): PrincipleRecord[] {
  return all<DbCard>(db, `SELECT * FROM principle_cards ORDER BY created_at`).map(mapCard);
}

/** 启用完整性校验（ER-R01 R6）：启用前必须有原文、来源定位与必填来源信息；
 *  有快照的卡要求快照真实存在。校验不过不得启用。 */
export function validateForEnable(db: Db, id: string): { ok: boolean; error?: string } {
  const c = get<DbCard>(db, `SELECT * FROM principle_cards WHERE id = ?`, id);
  if (!c) return { ok: false, error: '原则卡不存在' };
  if (!c.quote_en?.trim()) return { ok: false, error: '缺少原文摘录' };
  if (!c.position?.trim() || c.position.includes('待补充')) return { ok: false, error: '缺少来源定位（章节/小节或 [个人建议] 标注）' };
  if (!c.explanation_cn?.trim()) return { ok: false, error: '缺少中文解读（启用前必填）' };
  if (!c.boundary?.trim()) return { ok: false, error: '缺少适用边界（启用前必填）' };
  const origin = c.origin ?? 'import';
  if (origin === 'suggestion') return { ok: true }; // 个人建议：不要求不存在的 URL/快照
  if (c.snapshot_id) {
    const snap = get(db, `SELECT id FROM source_snapshots WHERE id = ?`, c.snapshot_id);
    if (!snap) return { ok: false, error: `来源快照缺失：${c.snapshot_id}` };
  } else if (!c.source_url) {
    return { ok: false, error: '该卡不是个人建议类型：必须提供来源快照或来源链接' };
  }
  return { ok: true };
}

/** 启用/停用：启用是用户显式确认的结果（界面二次确认后调用）；启用前校验完整性（R6） */
export function setCardEnabled(db: Db, id: string, enabled: boolean): { ok: boolean; error?: string } {
  if (enabled) {
    const v = validateForEnable(db, id);
    if (!v.ok) return v;
  }
  run(db, `UPDATE principle_cards SET enabled = ? WHERE id = ?`, enabled ? 1 : 0, id);
  return { ok: true };
}

/** 已启用原则卡（供复盘上下文，R6）：含来源与边界，受输入上限约束由调用方裁剪 */
export function enabledPrinciples(db: Db, limit = 8) {
  return all<DbCard>(
    db,
    `SELECT * FROM principle_cards WHERE enabled = 1 ORDER BY created_at LIMIT ?`,
    limit,
  ).map(mapCard);
}

/** 补全/编辑草稿卡（R6）：导入草稿的定位、解释、边界、来源 */
export function updateDraftCard(
  db: Db,
  id: string,
  patch: { position?: string; interpretation?: string; boundary?: string; sourceUrl?: string },
): { ok: boolean; error?: string } {
  const c = get<DbCard>(db, `SELECT * FROM principle_cards WHERE id = ?`, id);
  if (!c) return { ok: false, error: '原则卡不存在' };
  if (patch.position !== undefined) run(db, `UPDATE principle_cards SET position = ? WHERE id = ?`, patch.position, id);
  if (patch.interpretation !== undefined) run(db, `UPDATE principle_cards SET explanation_cn = ? WHERE id = ?`, patch.interpretation, id);
  if (patch.boundary !== undefined) run(db, `UPDATE principle_cards SET boundary = ? WHERE id = ?`, patch.boundary, id);
  if (patch.sourceUrl !== undefined) run(db, `UPDATE principle_cards SET source_url = ? WHERE id = ?`, patch.sourceUrl, id);
  return { ok: true };
}

/** 新增草稿卡（粘贴摘录 / Markdown/TXT 内容 / 个人建议）：一律先草稿，待用户确认启用 */
export function addDraftCard(
  db: Db,
  args: { text: string; sourceUrl?: string; origin: 'paste' | 'file' | 'suggestion' },
): PrincipleRecord {
  const id = newId();
  const origin = args.origin === 'suggestion' ? 'suggestion' : 'quote';
  run(
    db,
    `INSERT INTO principle_cards (id, quote_en, source_url, snapshot_id, position, explanation_cn, boundary, enabled, origin, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?)`,
    id,
    args.text.trim(),
    args.sourceUrl?.trim() || null,
    `[导入·${args.origin}] 待补充定位`,
    '',
    '',
    origin,
    nowIso(),
  );
  return mapCard(get(db, `SELECT * FROM principle_cards WHERE id = ?`, id)!);
}

interface DbCard {
  id: string; quote_en: string; source_url: string | null; snapshot_id: string | null;
  position: string; explanation_cn: string; boundary: string; enabled: number; created_at: string;
  origin?: string | null;
}

function mapCard(c: DbCard): PrincipleRecord {
  return {
    id: c.id,
    quoteOriginal: c.quote_en,
    sourceUrl: c.source_url,
    snapshotId: c.snapshot_id,
    position: c.position,
    interpretation: c.explanation_cn,
    boundary: c.boundary,
    enabled: c.enabled === 1,
    origin: c.origin ?? 'import',
    createdAt: c.created_at,
  };
}
