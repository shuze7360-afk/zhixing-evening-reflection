// 周期报告（docs/PRODUCT.md §6）：周报（周一至周日）/月报/年报。
// 规则：周期结束后、应用运行且预算允许时生成；空周期不生成；报告绑定日报修订、模型与提示词版本；
// 结论保留日报证据索引；日报修订更新后受影响报告标记过时，重新生成新版本并保留旧版。
// 纪律：无记录或少量记录时不编造趋势（校验与提示词双向约束）。
import { createHash } from 'node:crypto';
import { all, get, newId, nowIso, run, withTransaction, type Db } from './db';
import { completeChat, BigModelError, type FetchFn } from './bigmodel';
import { OUTPUT_ESTIMATE } from '../shared/config';
import { effectiveSpendCny, refund, reserve, settle, findHeldUsage, keepHold, type PriceConfig } from './budget';
import { fillTemplate, loadPrompt } from './prompts';
import { MAX_INPUT_BYTES } from '../shared/config';
import { getSettings, resolveApiConfig } from './settings';
import { createExportTask, exportTasksFor, runExportTask } from './obsidian';
import { toExportTaskRecord } from './reports';
import type { AppEvent, PeriodReportRecord } from '../shared/ipc';

export type PeriodKind = 'weekly' | 'monthly' | 'yearly';

export interface Period {
  kind: PeriodKind;
  start: string; // YYYY-MM-DD（含）
  end: string;   // YYYY-MM-DD（含）
  label: string; // 周报 2026-W40 / 月报 2026-09 / 年报 2026
}

function dstr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7) };
}

/** 周一至周日的一周，包含给定日期 */
export function weekContaining(date: Date): Period {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = (d.getDay() + 6) % 7; // 周一=0
  const start = new Date(d);
  start.setDate(d.getDate() - dow);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const { year, week } = isoWeek(start);
  return { kind: 'weekly', start: dstr(start), end: dstr(end), label: `周报 ${year}-W${String(week).padStart(2, '0')}` };
}

export function monthContaining(date: Date): Period {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { kind: 'monthly', start: dstr(start), end: dstr(end), label: `月报 ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` };
}

export function yearContaining(date: Date): Period {
  return { kind: 'yearly', start: `${date.getFullYear()}-01-01`, end: `${date.getFullYear()}-12-31`, label: `年报 ${date.getFullYear()}` };
}

/** 已结束的周期（end < 今天），每类取最近 count 个 */
export function completedPeriods(today: Date, count = { weekly: 8, monthly: 12, yearly: 2 }): Period[] {
  const out: Period[] = [];
  for (let i = 1; i <= count.weekly; i++) {
    const p = weekContaining(new Date(today.getTime() - i * 7 * 86_400_000));
    if (p.end < dstr(today)) out.push(p);
  }
  for (let i = 1; i <= count.monthly; i++) {
    const p = monthContaining(new Date(today.getFullYear(), today.getMonth() - i, 1));
    if (p.end < dstr(today)) out.push(p);
  }
  for (let i = 1; i <= count.yearly; i++) {
    const p = yearContaining(new Date(today.getFullYear() - i, today.getMonth(), today.getDate()));
    if (p.end < dstr(today)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

interface DbPeriod {
  id: string; kind: string; period_start: string; period_end: string; content_json: string; created_at: string;
}

export interface Bindings {
  daily_report_ids: string[];
  model: string | null;
  prompt_version: string | null;
  rev: number;
}

/** 日报修订更新（superseded）后，包含该日报的周期报告视为过时 */
export function isStale(db: Db, dailyIds: string[]): boolean {
  if (dailyIds.length === 0) return false;
  const marks = dailyIds.map(() => 'superseded_by IS NOT NULL').join(' OR ');
  const rows = all<{ id: string }>(
    db,
    `SELECT id FROM daily_reports WHERE (${marks}) AND id IN (${dailyIds.map(() => '?').join(',')})`,
    ...dailyIds,
  );
  return rows.length > 0;
}

export function listPeriodReports(db: Db): PeriodReportRecord[] {
  return all<DbPeriod>(db, `SELECT * FROM period_reports ORDER BY period_end DESC, created_at DESC`).map((r) =>
    mapPeriod(r, db),
  );
}

export function getPeriodReport(db: Db, id: string): PeriodReportRecord | undefined {
  const r = get<DbPeriod>(db, `SELECT * FROM period_reports WHERE id = ?`, id);
  return r ? mapPeriod(r, db) : undefined;
}

export function mapPeriod(r: DbPeriod, db: Db): PeriodReportRecord {
  let parsed = {
    coverage: '',
    highlights: [] as string[],
    patterns: [] as string[],
    open_questions: [] as string[],
    bindings: { daily_report_ids: [] as string[], model: null as string | null, prompt_version: null as string | null, rev: 1 },
  };
  try {
    parsed = { ...parsed, ...(JSON.parse(r.content_json) as Partial<typeof parsed>) };
  } catch { /* 防御 */ }
  // G4：返回最新导出任务（与日报同等）——成长回顾页据此展示导出状态/重试/解决目标入口
  const latestTask = exportTasksFor(db, r.id)[0];
  return {
    id: r.id,
    kind: r.kind as PeriodReportRecord['kind'],
    periodStart: r.period_start,
    periodEnd: r.period_end,
    label: '',
    coverage: parsed.coverage,
    highlights: parsed.highlights,
    patterns: parsed.patterns,
    openQuestions: parsed.open_questions,
    bindings: parsed.bindings,
    stale: isStale(db, parsed.bindings.daily_report_ids),
    exportTask: latestTask ? toExportTaskRecord(latestTask, db) : null,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export type GenerateResult =
  | { ok: true; report: PeriodReportRecord }
  | { ok: false; error: 'empty' | 'budget_paused' | 'invalid' | 'model' | 'no_key'; detail?: string; spendCny?: number; limitCny?: number };

export function createPeriodService(deps: {
  db: Db;
  promptsBaseDir: string;
  fetchFn?: FetchFn;
  appVersion: string;
  getApiKey: () => string | null;
  notifyApp(e: AppEvent): void;
}) {
  const { db } = deps;

  function dailyInPeriod(start: string, end: string) {
    return all<{ id: string; date: string; content_json: string; rev: number }>(
      db,
      `SELECT id, date, content_json, rev FROM daily_reports
        WHERE date >= ? AND date <= ? AND formal = 1 AND superseded_by IS NULL
        ORDER BY date`,
      start,
      end,
    );
  }

  async function generate(period: Period, signal?: AbortSignal): Promise<GenerateResult> {
    const dailies = dailyInPeriod(period.start, period.end);
    if (dailies.length === 0) {
      return { ok: false, error: 'empty', detail: `空周期（${period.start} ~ ${period.end}）不生成` };
    }

    const days = Math.round((new Date(period.end).getTime() - new Date(period.start).getTime()) / 86_400_000) + 1;
    const distinctDates = new Set(dailies.map((d) => d.date));
    const coverage = `共 ${dailies.length} 份正式日报（${dailies[0].date} ~ ${dailies[dailies.length - 1].date}，覆盖 ${distinctDates.size} 个不同日期）；周期共 ${days} 天，未记录的日子如实空缺。`;

    const BATCH_LIMIT = MAX_INPUT_BYTES - 4096;
    const byteLen = (t: string): number => Buffer.byteLength(t, 'utf8');

    const perDay = (d: (typeof dailies)[number]): { header: string; lines: string[] } => {
      let c: { experiences?: string[]; feelings?: string[]; keep_practices?: string[] } | null = null;
      try {
        c = JSON.parse(d.content_json);
      } catch {
        /* 防御 */
      }
      return {
        header: `【${d.date}（修订 v${d.rev}）】`,
        lines: [
          `- 经历：${(c?.experiences ?? []).join('；') || '（无）'}`,
          `- 感受：${(c?.feelings ?? []).join('；') || '（无）'}`,
          `- 保留做法：${(c?.keep_practices ?? []).join('；') || '（无）'}`,
        ],
      };
    };

    // T4/W3 切分：单元=每日报一块；单日超限时**先逐条目**重组行片段（条目不跨片段断裂），
    // 单条目自身仍超限才按 CodePoint 边界切片；每片 ≤ BATCH_LIMIT，片段拼接内容无损。
    const units: string[] = [];
    for (const d of dailies) {
      const { header, lines } = perDay(d);
      const whole = header + '\n' + lines.join('\n');
      if (byteLen(whole) <= BATCH_LIMIT) {
        units.push(whole);
        continue;
      }
      const headerSize = byteLen(header + '\n');
      const maxLine = BATCH_LIMIT - headerSize - 1; // 行 + 换行须容纳
      // 行 → 条目级片段行（'- 经历：' 等前缀在每个片段行首重述，模型可识别续行）
      const fragLines: string[] = [];
      for (const line of lines) {
        if (byteLen(line) + 1 <= maxLine) {
          fragLines.push(line);
          continue;
        }
        const mc = line.match(/^- ([^：]+)：([\s\S]*)$/);
        const pfx = mc ? `- ${mc[1]}：` : '';
        const items = mc && mc[2] !== '（无）' ? mc[2].split('；') : [line];
        let cur: string | null = null;
        for (const it of items) {
          const piece: string = cur === null ? it : '；' + it;
          if (byteLen((cur ?? pfx) + piece) + 1 <= maxLine) {
            cur = (cur ?? pfx) + piece;
            continue;
          }
          if (cur !== null) fragLines.push(cur);
          // W3：单条目仍超限 → 按 CodePoint 安全边界切片（顺序无损）
          // F4：for...of 按码点迭代，但 String.slice 按 UTF-16 code unit 下标——
          // 必须累计**code unit 长度**（ch.length：BMP=1、代理对=2）作为切分下标，
          // 否则非 BMP 字符（emoji）会被从代理对中间劈开，产生孤代理的无效片段。
          let work = it;
          const cap = maxLine - byteLen(pfx) - 1;
          while (byteLen(pfx + work) + 1 > maxLine) {
            let takeUnits = 0;
            let bytes = 0;
            for (const ch of work) {
              const cb = byteLen(ch);
              if (bytes + cb > cap) break;
              bytes += cb;
              takeUnits += ch.length; // F4：code unit 数（不拆代理对）
            }
            if (takeUnits === 0) break; // 防御：单字符超限（容量极小）时终止
            fragLines.push(pfx + work.slice(0, takeUnits));
            work = work.slice(takeUnits);
          }
          cur = pfx + work;
        }
        if (cur !== null) fragLines.push(cur);
      }
      // 片段行装箱为 chunk（每 chunk = header + 若干行，≤ BATCH_LIMIT）
      const chunks: string[] = [];
      let chunkLines: string[] = [];
      let chunkSize = headerSize;
      for (const fl of fragLines) {
        const fs = byteLen(fl + '\n');
        if (chunkSize + fs > BATCH_LIMIT && chunkLines.length > 0) {
          chunks.push(header + '\n' + chunkLines.join('\n'));
          chunkLines = [];
          chunkSize = headerSize;
        }
        chunkLines.push(fl);
        chunkSize += fs;
      }
      if (chunkLines.length > 0) chunks.push(header + '\n' + chunkLines.join('\n'));
      chunks.forEach((chunk, ci) => {
        units.push(chunks.length > 1 ? chunk.replace(header, header.slice(0, -1) + '·片段 ' + (ci + 1) + '/' + chunks.length + '】') : chunk);
      });
    }
    const batches: string[][] = [];
    let cur: string[] = [];
    let curSize = 0;
    for (const unit of units) {
      const us = byteLen(unit + '\n\n');
      if (curSize + us > BATCH_LIMIT && cur.length > 0) {
        batches.push(cur);
        cur = [];
        curSize = 0;
      }
      cur.push(unit);
      curSize += us;
    }
    if (cur.length > 0) batches.push(cur);

    const apiKey = deps.getApiKey();
    if (!apiKey) return { ok: false, error: 'no_key', detail: '尚未配置 API Key' };

    const s = getSettings(db);
    const price: PriceConfig = {
      inCnyPerMtok: s.priceInCnyPerMtok ?? 8,
      outCnyPerMtok: s.priceOutCnyPerMtok ?? 8,
    };
    const template = loadPrompt(deps.promptsBaseDir, 'v1', 'period-report');
    const kindCn = period.kind === 'weekly' ? '周报' : period.kind === 'monthly' ? '月报' : '年报';

    type PartialT = { coverage: string; highlights: string[]; patterns: string[]; open_questions: string[] };

    /** T4 统一发送边界：reserve（同事务记录）→ 请求 → 先存原文 → 结算/退款/保留 → 校验。
     *  发送前校验完整序列化请求 ≤24KiB（含系统提示与 JSON 包装）。 */
    const runModelJson = async (
      label: string,
      system: string,
      user: string,
      reqSignal: AbortSignal | undefined,
    ): Promise<
      | { ok: true; content: PartialT }
      | { ok: false; error: 'budget_paused' | 'model' | 'invalid'; detail?: string; spendCny?: number; limitCny?: number }
    > => {
      const messages = [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: user },
      ];
      const serialized = JSON.stringify({ messages });
      const bodyBytes = byteLen(serialized);
      if (bodyBytes > MAX_INPUT_BYTES) {
        return { ok: false, error: 'model', detail: `内部错误：请求 ${bodyBytes} 字节超过 ${MAX_INPUT_BYTES} 上限（切分缺陷，已阻止发送）` };
      }
      const reqId = newId();
      const slot = reserve(db, {
        requestId: reqId, kind: 'refine',
        estInTokens: system.length + user.length,
        maxOutTokens: OUTPUT_ESTIMATE.refine,
        price, limitCny: s.budgetMonthlyCny,
      }, () => {
        run(
          db,
          `INSERT INTO model_requests (id, session_id, kind, prompt_version, status, payload_summary, created_at)
           VALUES (?, NULL, 'refine', 'v1', 'running', ?, ?)`,
          reqId,
          label + ' · 请求 ' + bodyBytes + ' 字节',
          nowIso(),
        );
      });
      if (!slot.allowed) {
        return {
          ok: false, error: 'budget_paused',
          detail: `月度预算超限（约 ${slot.spendCny.toFixed(2)} / ${slot.limitCny.toFixed(2)} 元），周期报告暂停；已完成批次已落检查点。`,
          spendCny: slot.spendCny, limitCny: slot.limitCny,
        };
      }
      deps.notifyApp({ type: 'budget', monthlySpendCny: effectiveSpendCny(db), limitCny: s.budgetMonthlyCny, paused: false });
      try {
        const api = resolveApiConfig(db); // 多模型兼容
        const result = await completeChat({ apiKey, fetchFn: deps.fetchFn, chatUrl: api.chatUrl, model: api.model }, { messages, signal: reqSignal });
        run(db, `UPDATE model_requests SET raw_response = ? WHERE id = ?`, result.content, reqId);
        settle(db, slot.usageId!, result.usage, system.length + user.length, OUTPUT_ESTIMATE.refine, price);
        run(db, `UPDATE model_requests SET status = 'verified', finished_at = ? WHERE id = ?`, nowIso(), reqId);
        const parsed = parsePeriodReportJson(result.content);
        if (!parsed.ok) {
          return { ok: false, error: 'invalid', detail: `${label} 校验失败：${parsed.errors[0] ?? ''}` };
        }
        return { ok: true, content: parsed.content };
      } catch (err) {
        const e = err instanceof BigModelError ? err : new BigModelError('unknown', String((err as Error)?.message ?? err));
        const reqRow = get<{ status: string }>(db, `SELECT status FROM model_requests WHERE id = ?`, reqId);
        if (reqRow?.status === 'running') {
          if (e.errorClass === 'timeout' || e.errorClass === 'network' || e.errorClass === 'unknown') {
            run(db, `UPDATE model_requests SET status = 'unknown', error_message = ? WHERE id = ?`, e.message, reqId);
            const u = findHeldUsage(db, reqId);
            if (u) keepHold(db, u.id);
          } else {
            run(db, `UPDATE model_requests SET status = 'failed', error_class = ?, error_message = ? WHERE id = ?`, e.errorClass, e.message, reqId);
            const u = findHeldUsage(db, reqId);
            if (u) refund(db, u.id);
          }
        }
        return { ok: false, error: 'model', detail: label + ' 失败：' + e.message };
      }
    };

    // T4/W4 持久检查点：指纹 = 提示词版本 + 聚合策略 + 批次内容；一致才复用（不重复请求/计费）。
    // W4：检查点覆盖首层批次与每一层聚合组（组输入指纹 + 结果），重试从未完成组继续；
    // 仅保存已验证成功的结果（unknown 状态请求无结果可复用，重跑由保留的预算预占覆盖重复计费风险）。
    // F5：检查点同时保存**已验证的最终汇总**（发布前落盘）——发布失败重试零重复 final fetch。
    const ckptKey = `periodic_ckpt:${period.kind}:${period.start}:${period.end}`;
    const markerKey = `periodic_published:${period.kind}:${period.start}:${period.end}`;
    const fingerprint = createHash('sha256')
      .update('v1\nagg2\n' + batches.map((b) => b.join('\n\u0000')).join('\n\n\u0000'))
      .digest('hex');
    type AggEntry = { fp: string; result: PartialT };
    let partials: PartialT[] = [];
    let aggLevels: AggEntry[][] = [];
    let savedFinal: PartialT | null = null;
    const ckptRow = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, ckptKey);
    if (ckptRow) {
      try {
        const saved = JSON.parse(ckptRow.value) as {
          fingerprint?: string; promptVersion?: string; partials?: PartialT[]; aggLevels?: unknown;
          final?: { fp?: string; result?: PartialT };
        };
        if (saved.fingerprint === fingerprint && saved.promptVersion === 'v1' && Array.isArray(saved.partials)) {
          partials = saved.partials;
          if (Array.isArray(saved.aggLevels)) {
            aggLevels = saved.aggLevels
              .filter((lv): lv is unknown[] => Array.isArray(lv))
              .map((lv) =>
                lv.filter(
                  (e): e is AggEntry =>
                    !!e && typeof e === 'object' && typeof (e as AggEntry).fp === 'string' && !!(e as AggEntry).result,
                ),
              );
          }
          // F5：最终汇总结果已落检查点（同指纹）→ 直接复用，不再调用模型
          if (saved.final && saved.final.fp === fingerprint && saved.final.result) {
            savedFinal = saved.final.result;
          }
        }
      } catch {
        /* 损坏检查点视为无 */
      }
    }
    const saveCheckpoint = (): void => {
      run(
        db,
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ckptKey,
        JSON.stringify({ fingerprint, promptVersion: 'v1', partials, aggLevels }),
      );
    };
    const saveFinalCheckpoint = (result: PartialT): void => {
      run(
        db,
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ckptKey,
        JSON.stringify({ fingerprint, promptVersion: 'v1', partials, aggLevels, final: { fp: fingerprint, result } }),
      );
    };
    const clearCheckpoint = (): void => {
      run(db, `DELETE FROM meta WHERE key = ?`, ckptKey);
    };

    // F5/G3：同指纹的正式报告已发布过（如发布后导出排程失败的重试）→ 直接复用该报告：
    // 不产生新修订、零模型请求，仅重新排程导出（导出本身幂等）。
    // G3：标记**解析失败**与**排程失败**分开处理——只有解析失败才视为无标记；
    // 已发布报告一旦命中，任何本地导出排程错误都明确返回（绝不回落模型生成）。
    const markerRow = get<{ value: string }>(db, `SELECT value FROM meta WHERE key = ?`, markerKey);
    let marker: { fp?: string; reportId?: string } | null = null;
    if (markerRow) {
      try {
        marker = JSON.parse(markerRow.value) as { fp?: string; reportId?: string };
      } catch {
        marker = null; // 仅损坏标记视为无
      }
    }
    if (marker && marker.fp === fingerprint && marker.reportId) {
      const existing = getPeriodReport(db, marker.reportId);
      if (existing) {
        let taskId: string;
        try {
          taskId = createExportTask(db, {
            refId: existing.id,
            kind: 'period_report',
            targetRel: periodTargetRel(existing),
            contentHash: 'pending',
          });
        } catch (err) {
          return {
            ok: false, error: 'invalid',
            detail: `报告已发布（修订 v${existing.bindings.rev}），但导出排程失败：${(err as Error).message}；请稍后重试（不会重新调用模型）`,
          };
        }
        queueMicrotask(async () => {
          deps.notifyApp({ type: 'export', taskId, refId: existing.id, status: 'running' });
          const r = await runExportTask(db, taskId, deps.appVersion);
          deps.notifyApp({ type: 'export', taskId, refId: existing.id, status: r.status, targetRel: r.targetRel, error: r.error });
        });
        return { ok: true, report: existing };
      }
    }

    // 批处理：检查点之后的批次逐个执行；每批成功即落检查点
    for (let bi = partials.length; bi < batches.length && !savedFinal; bi++) {
      const batchDigest = batches[bi].join('\n\n');
      const batchSystem = fillTemplate(template, {
        KIND_CN: kindCn + '（分批中间摘要）',
        PERIOD: `${period.label}（${period.start} ~ ${period.end}）`,
        COVERAGE: `第 ${bi + 1}/${batches.length} 批：本批 ${batches[bi].length} 份日报。`,
        DAILY_DIGEST: batchDigest,
      });
      const r = await runModelJson(
        `周期报告批次 ${bi + 1}/${batches.length} · ${period.label}`,
        batchSystem,
        '请输出本批的中间摘要 JSON。',
        signal,
      );
      if (!r.ok) return r;
      partials.push(r.content);
      saveCheckpoint();
    }

    // T4/W4 分层聚合：摘要拼起仍超限 → 逐组聚合为上层摘要，循环直到单请求可容纳。
    // 每层每组结果即时落检查点（组输入指纹 = 组内条目 + 标签 + 聚合策略版本）；
    // 重试时组按确定性重算，指纹命中的已成功组直接复用（零重复 fetch/计费）。
    let level: PartialT[] = partials;
    let labels: string[] = batches.map((_, i2) => `批次 ${i2 + 1}`);
    const summarize = (items: PartialT[], ls: string[]): string =>
      items
        .map((p, i3) => `【${ls[i3]}】\n值得记下：${p.highlights.join('；') || '（无）'}\n模式：${p.patterns.join('；') || '（无）'}\n待验证：${p.open_questions.join('；') || '（无）'}`)
        .join('\n\n');
    let guard = 0;
    let li = 0; // 当前聚合层索引（检查点按层存储）
    while (!savedFinal && byteLen(summarize(level, labels)) > BATCH_LIMIT && level.length > 1) {
      if (++guard > 10) {
        return { ok: false, error: 'invalid', detail: '分层聚合未收敛（防御性终止）' };
      }
      const groups: { items: PartialT[]; labels: string[] }[] = [];
      let gItems: PartialT[] = [];
      let gLabels: string[] = [];
      let gSize = 0;
      for (let i2 = 0; i2 < level.length; i2++) {
        const t = summarize([level[i2]], [labels[i2]]) + '\n\n';
        const ts = byteLen(t);
        if (gSize + ts > BATCH_LIMIT && gItems.length > 0) {
          groups.push({ items: gItems, labels: gLabels });
          gItems = [];
          gLabels = [];
          gSize = 0;
        }
        gItems.push(level[i2]);
        gLabels.push(labels[i2]);
        gSize += ts;
      }
      if (gItems.length > 0) groups.push({ items: gItems, labels: gLabels });
      const savedEntries = aggLevels[li] ?? [];
      aggLevels[li] = savedEntries;
      const nextLevel: PartialT[] = [];
      const nextLabels: string[] = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const groupLabel = `聚合层 ${gi + 1}`;
        const groupFp = createHash('sha256')
          .update(JSON.stringify({ v: 'agg2', items: groups[gi].items, labels: groups[gi].labels }))
          .digest('hex');
        const saved = savedEntries.find((e2) => e2.fp === groupFp);
        if (saved) {
          nextLevel.push(saved.result);
          nextLabels.push(groupLabel);
          continue; // W4：已成功组零重复 fetch（检查点续跑）
        }
        const sys = fillTemplate(template, {
          KIND_CN: kindCn + `（分层聚合 ${gi + 1}/${groups.length}）`,
          PERIOD: `${period.label}（${period.start} ~ ${period.end}）`,
          COVERAGE: coverage,
          DAILY_DIGEST: summarize(groups[gi].items, groups[gi].labels),
        });
        const r = await runModelJson(
          `周期报告分层聚合 ${gi + 1}/${groups.length} · ${period.label}`,
          sys,
          '请输出本层汇总 JSON。',
          signal,
        );
        if (!r.ok) return r;
        savedEntries.push({ fp: groupFp, result: r.content });
        saveCheckpoint();
        nextLevel.push(r.content);
        nextLabels.push(groupLabel);
      }
      level = nextLevel;
      labels = nextLabels;
      li += 1;
    }

    // F5：最终汇总——已落检查点的结果直接复用（零重复 fetch）；新结果先落检查点再发布。
    let finalContent: PartialT;
    if (savedFinal) {
      finalContent = savedFinal;
    } else {
      const finalSystem = fillTemplate(template, {
        KIND_CN: kindCn + '（最终汇总）',
        PERIOD: `${period.label}（${period.start} ~ ${period.end}）`,
        COVERAGE: coverage,
        DAILY_DIGEST: `各批次中间摘要如下，请汇总为最终${kindCn}：\n\n${summarize(level, labels)}`,
      });
      const finalRun = await runModelJson(
        `周期报告最终汇总 · ${period.label}`,
        finalSystem,
        '请输出最终' + kindCn + ' JSON。',
        signal,
      );
      if (!finalRun.ok) return finalRun;
      finalContent = finalRun.content;
      saveFinalCheckpoint(finalContent); // F5：已验证且已计费的最终结果先持久化，再进行本地发布
    }

    // F5：发布事务（原子）——插入正式报告 + 清除检查点 + 写已发布标记要么全部生效要么全部回滚；
    // 任一步失败重试时：标记未写 → 走 savedFinal 复用路径重新发布（零模型请求）；不产生残缺状态。
    let reportId = '';
    try {
      withTransaction(db, () => {
        const rev =
          all<{ n: number }>(
            db,
            `SELECT COUNT(*) AS n FROM period_reports WHERE kind = ? AND period_start = ? AND period_end = ?`,
            period.kind,
            period.start,
            period.end,
          )[0].n + 1;
        const content = {
          ...finalContent,
          bindings: {
            daily_report_ids: dailies.map((d) => d.id),
            model: resolveApiConfig(db).model,
            prompt_version: 'v1',
            rev,
          },
        };
        reportId = newId();
        run(
          db,
          `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          reportId, period.kind, period.start, period.end, JSON.stringify(content), nowIso(),
        );
        clearCheckpoint(); // T4：正式发布成功 → 清除检查点（与插入同事务）
        run(
          db,
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          markerKey,
          JSON.stringify({ fp: fingerprint, reportId }),
        );
      });
    } catch (err) {
      // F5：本地发布失败不重新消费模型——最终结果已在检查点中，明确返回可重试错误
      return {
        ok: false, error: 'invalid',
        detail: `本地发布失败：${(err as Error).message}；已验证的最终结果已保存，重试将直接复用（零模型请求）`,
      };
    }
    const record = mapPeriod(get(db, `SELECT * FROM period_reports WHERE id = ?`, reportId)!, db);
    // G3：首次发布后的导出排程若失败——报告已正式发布（标记已写），明确返回而不是抛出；
    // 重试会命中上方已发布复用分支，只补做导出（零模型请求、不产生新修订）。
    let taskId: string;
    try {
      taskId = createExportTask(db, {
        refId: record.id,
        kind: 'period_report',
        targetRel: periodTargetRel(record),
        contentHash: 'pending',
      });
    } catch (err) {
      return {
        ok: false, error: 'invalid',
        detail: `报告已发布（修订 v${record.bindings.rev}），但导出排程失败：${(err as Error).message}；重试将只补做导出（零模型请求）`,
      };
    }
    queueMicrotask(async () => {
      deps.notifyApp({ type: 'export', taskId, refId: record.id, status: 'running' });
      const r = await runExportTask(db, taskId, deps.appVersion);
      deps.notifyApp({ type: 'export', taskId, refId: record.id, status: r.status, targetRel: r.targetRel, error: r.error });
    });
    return { ok: true, report: record };
  }

  return { generate, dailyInPeriod };
}

export function periodTargetRel(r: PeriodReportRecord): string {
  const folder = r.kind === 'weekly' ? '周报' : r.kind === 'monthly' ? '月报' : '年报';
  const base =
    r.bindings.rev > 1
      ? `${r.periodStart}_${r.periodEnd}.r${r.bindings.rev}`
      : `${r.periodStart}_${r.periodEnd}`;
  return `${folder}/${base}.md`;
}

// ---------------------------------------------------------------------------
// JSON 校验
// ---------------------------------------------------------------------------

export function parsePeriodReportJson(text: string):
  | { ok: true; content: { coverage: string; highlights: string[]; patterns: string[]; open_questions: string[] } }
  | { ok: false; errors: string[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, errors: ['输出中未找到 JSON 对象'] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败：${(e as Error).message}`] };
  }
  const errors: string[] = [];
  const arr = (v: unknown, name: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      errors.push(`${name}: 不是数组`);
      return [];
    }
    return v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 300)
      .slice(0, 6);
  };
  const coverage = typeof parsed.coverage === 'string' && parsed.coverage.trim() ? parsed.coverage : '';
  if (!coverage) errors.push('coverage: 缺失或为空');
  const highlights = arr(parsed.highlights, 'highlights');
  const patterns = arr(parsed.patterns, 'patterns');
  const openQuestions = arr(parsed.open_questions, 'open_questions');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, content: { coverage, highlights, patterns, open_questions: openQuestions } };
}
