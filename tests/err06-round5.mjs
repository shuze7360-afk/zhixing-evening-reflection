// ER-R01 第五轮修正反例（对应 Codex 第五轮审阅 F1—F5；F6/F7 见 err05-round4）。
// 每项：修复前失败 / 修复后通过；隔离数据库、mock fetch、临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const mod = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const { openDb, get, all, run, withTransaction } = require(join(ROOT, 'dist/main/db.js'));
const settingsMod = require(join(ROOT, 'dist/main/settings.js'));

function rmTmp(dir) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); }
  }
}
function jsonResp(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), text: async () => '' };
}
function sse2(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return { ok: true, status: 200, body: { getReader() { return { read() { if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) }); return Promise.resolve({ done: true }); } }; } } };
}
function mkContent(over = {}) {
  return {
    coverage: 'c', experiences: [], feelings: [], keep_practices: [], open_questions: [],
    related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [], fact_sources: [],
    ...over,
  };
}
const NOTE = '（待核对感受）「开心」——如确属你的感受，请在日报中确认；含否定/转述/假设时不应确认';

// ---------------------------------------------------------------------------
// F1：恢复 gate 约束既有连接的全部写入（暂存/checkpoint/替换各阶段 gate 均存在）；
// gate 原子创建（wx 独占创建）
// ---------------------------------------------------------------------------

test('F1 既有连接恢复期间写入被拒绝、释放后恢复；gate 原子创建语义', () => {
  const tmp = join(tmpdir(), `er06-f1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 连接在恢复开始**之前**打开（MCP 常驻场景）
    const db = openDb(dbPath);
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe', '1', 't')`);
    // 恢复开始：gate 出现（原子独占创建）
    writeFileSync(dbPath + '.restore-gate', '{}', { flag: 'wx' });
    // 已有连接的一切写入路径必须被拒绝——不能在旧连接中成功提交
    assert.throws(() => run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe2', '2', 't')`), /恢复/, 'run() 写入必须被拒绝');
    assert.throws(() => withTransaction(db, () => run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe3', '3', 't')`)), /恢复/, '事务写入必须被拒绝');
    // 拒绝发生在任何写入之前（无半成品）
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'probe%'`).n, 1, '被拒绝的写入不得产生任何行');
    // gate 释放（恢复成功/回滚）→ 同一连接即可继续写入
    unlinkSync(dbPath + '.restore-gate');
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('after', '4', 't')`);
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM settings WHERE key='after'`).n, 1, 'gate 释放后写入恢复');
    db.close();
    // gate 原子创建：独占创建（wx）对已存在文件必须失败（两个恢复者不能同时通过）
    const g = join(tmp, 'atomic-gate');
    writeFileSync(g, 'first', { flag: 'wx' });
    assert.throws(() => writeFileSync(g, 'second', { flag: 'wx' }), (e) => /EEXIST|file already exists/i.test(String(e.code ?? e.message)), 'wx 已存在必须失败');
    // wiring：acquireGate 必须使用原子创建，而不是 exists 后普通写入
    const src = readFileSync(join(ROOT, 'dist/main/backup.js'), 'utf8');
    assert.ok(src.includes("flag: 'wx'"), 'acquireGate 必须用 wx 原子创建 gate');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// F2：模型伪造程序所有字段（feelings_confirmed / actions_accepted / fact_sources）
// 必须在解析层剥离 + sanitize 层显式覆盖，绝不正式化
// ---------------------------------------------------------------------------

test('F2 模型伪造确认/接受/溯源字段：正式日报全部为空，只有真实确认能改变状态', async () => {
  const tmp = join(tmpdir(), `er06-f2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const seq = [
      () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(JSON.stringify({
        coverage: 'c',
        experiences: ['我今天没有开心，反而很难过。'],
        feelings: [],
        keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [],
        // F2 反例：模型伪造程序所有字段
        feelings_confirmed: ['非常开心（模型伪造已确认）'],
        actions_accepted: [{ action: '伪造的已接受行动', accepted_at: '2025-01-01T00:00:00Z' }],
        fact_sources: [{ item: '伪造的事实溯源', messageId: 'msg-forged' }],
      })),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0',
      cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e },
      fetchFn: async () => { const n = seq.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '我今天没有开心，反而很难过。' });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, true, end.detail);
    await new Promise((r) => setTimeout(r, 250));
    const content = JSON.parse(svc.getToday().latestReport.contentJson);
    assert.deepEqual(content.feelings_confirmed, [], '伪造的确认字段不得进入正式日报');
    assert.deepEqual(content.actions_accepted, [], '伪造的已接受行动不得进入正式日报');
    assert.deepEqual(content.fact_sources.map((f) => f.item), ['我今天没有开心，反而很难过。'], '溯源只来自程序校验的真实原话');
    assert.deepEqual(content.feelings, [], '伪造确认不得让感受正式化');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// F3：旧页面确认 → 明确 stale（当前内容不回退）；重复确认幂等（不重复产生修订）
// ---------------------------------------------------------------------------

const reports = mod('reports');

test('F3-a 旧修订上确认感受：明确 stale，当前汇总不回退、不产生新修订', () => {
  const tmp = join(tmpdir(), `er06-f3a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    // v1：早晨记录 + 一条待核对感受
    const v1 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['早晨记录'], ai_notes: [NOTE] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    // v2（当前）：新增下午记录
    const v2 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['早晨记录', '下午新增记录'], ai_notes: [NOTE] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    // 停留在 v1 的页面提交确认
    const r = reports.confirmReportFeeling(db, { reportId: v1.id, item: NOTE, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r.ok, false, '旧修订上的确认必须失败');
    assert.equal(r.error, 'stale', `明确返回 stale：${JSON.stringify(r)}`);
    // 当前版仍是 v2，内容不回退（下午新增记录保留），无 v3 产生
    const currents = all(db, `SELECT id, content_json FROM daily_reports WHERE formal=1 AND superseded_by IS NULL`);
    assert.equal(currents.length, 1);
    assert.equal(currents[0].id, v2.id, '当前版未被旧内容顶替');
    const c = JSON.parse(currents[0].content_json);
    assert.ok(c.experiences.includes('下午新增记录'), '当前汇总内容不回退');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '未产生新修订');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('F3-b 重复确认幂等：同一感受不重复追加、不重复产生修订', async () => {
  const tmp = join(tmpdir(), `er06-f3b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const v1 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['早晨记录'], ai_notes: [NOTE] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    const r1 = reports.confirmReportFeeling(db, { reportId: v1.id, item: NOTE, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '首次确认产生新修订');
    // 重复提交（快速双击/刷新前重试）：待核对项已不在当前版、感受已在确认记录 → 幂等 ok，不产生第三份
    const r2 = reports.confirmReportFeeling(db, { reportId: r1.report.id, item: NOTE, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r2.ok, true, `重复确认应幂等成功：${JSON.stringify(r2)}`);
    assert.equal(r2.report.id, r1.report.id, '幂等返回当前版（同一修订）');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '不重复产生修订');
    const c = JSON.parse(reports.getReport(db, r1.report.id).content_json);
    assert.equal(c.feelings.filter((f) => f === '开心').length, 1, '感受不重复追加');
    assert.equal(c.feelings_confirmed.filter((f) => f === '开心').length, 1, '确认记录不重复');
    await new Promise((r) => setTimeout(r, 250)); // 等确认触发的导出微任务完成，避免关库后异步活动
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// F4：emoji（代理对）超限切分——片段必须都是有效 Unicode、拼接无损、请求不超限
// ---------------------------------------------------------------------------

test('F4 emoji 单条超限切分：不拆代理对、每片段有效、拼接无损还原', async () => {
  const tmp = join(tmpdir(), `er06-f4-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 😀 = U+1F600（代理对 2 code units，UTF-8 4 字节）×9000 = 36KB，必然行内越界
    const item = '😀'.repeat(9000);
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('big','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: [item] })));
    // 夹具自检：输入确实越界
    assert.ok(Buffer.byteLength('- 经历：' + item, 'utf8') > 20 * 1024, '夹具自检：单条目确实越界');
    const bodies = [];
    const texts = [];
    const period = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        bodies.push(Buffer.byteLength(init.body, 'utf8'));
        texts.push(JSON.parse(init.body).messages.map((m) => m.content).join('\n'));
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    const r = await period.generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    assert.ok(bodies.length >= 2, `应多个请求（实测 ${bodies.length}）`);
    for (const [i, b] of bodies.entries()) assert.ok(b < 24 * 1024, `第 ${i + 1} 请求 ${b} 字节超限`);
    // 每个片段都是有效 Unicode：不得以孤立高代理结尾、不得以孤立低代理开头
    const frags = [];
    for (const t of texts) {
      for (const m of t.matchAll(/^- 经历：(😀+)$/gmu)) {
        frags.push(m[1]);
        assert.ok(!/[\uD800-\uDBFF]$/.test(m[1]), '片段不得以孤立高代理结尾（F4 核心）');
        assert.ok(!/^[\uDC00-\uDFFF]/.test(m[1]), '片段不得以孤立低代理开头');
      }
    }
    assert.ok(frags.length >= 2, `应切成多个片段（实测 ${frags.length}）`);
    assert.equal(frags.join(''), item, '按顺序拼接必须无损还原原条目');
    assert.ok(/·片段 \d+\/\d+】/.test(texts.join('\n')), '片段索引标记存在');
    await new Promise((res) => setTimeout(res, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// F5：最终汇总成功后本地发布失败 → 重试零重复 final fetch、恰好一份报告；
// 同指纹再次生成 → 复用已发布报告（不产生新修订、零模型请求）
// ---------------------------------------------------------------------------

test('F5 发布失败重试零重复 final fetch；已发布报告同指纹复用', async () => {
  const tmp = join(tmpdir(), `er06-f5-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('d0','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['普通的一天记录'] })));
    let finalFetches = 0;
    const fetchFn = async (_url, init) => {
      const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
      if (sys.includes('最终汇总')) finalFetches++;
      return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
    };
    const mkService = () => mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn, notifyApp: () => undefined,
    });
    // 第一次：最终汇总成功，但本地发布被 BEFORE INSERT 触发器注入失败
    run(db, `CREATE TRIGGER fail_publish BEFORE INSERT ON period_reports
             BEGIN SELECT RAISE(ABORT, '注入的发布失败'); END`);
    const r1 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r1.ok, false, '发布失败必须明确返回（而非抛出未处理异常）');
    assert.ok((r1.detail ?? '').includes('本地发布失败'), r1.detail);
    assert.equal(finalFetches, 1, '最终汇总已请求一次');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 0, '没有半成品报告');
    // 修复注入 → 重试：最终结果从检查点复用，零重复 final fetch
    run(db, `DROP TRIGGER fail_publish`);
    const r2 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r2.ok, true, r2.detail);
    assert.equal(finalFetches, 1, `重试不得重复请求最终汇总（实测 ${finalFetches}）`);
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '恰好一份正式报告');
    assert.equal(all(db, `SELECT status FROM model_requests WHERE kind='refine' AND status='verified'`).length, 2, '请求合计两条 verified（1 首层批 + 1 最终汇总——重试零新增）');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM model_requests WHERE kind='refine' AND status='verified' AND payload_summary LIKE '%最终汇总%'`).n, 1, '最终汇总请求恰好一条 verified（零重复）');
    assert.equal(get(db, `SELECT value FROM meta WHERE key='periodic_ckpt:weekly:2025-01-01:2025-01-01'`), undefined, '检查点已清除');
    const ckptKey = 'periodic_published:weekly:2025-01-01:2025-01-01';
    assert.ok(get(db, `SELECT value FROM meta WHERE key=?`, ckptKey), '已发布标记存在');
    await new Promise((res) => setTimeout(res, 250));
    // 同数据再次生成（同指纹）：直接复用已发布报告——不产生新修订、零模型请求
    const r3 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r3.ok, true, r3.detail);
    assert.equal(r3.report.id, r2.report.id, '同指纹复用已发布报告');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '不产生重复修订');
    assert.equal(finalFetches, 1, '复用路径零模型请求');
    await new Promise((res) => setTimeout(res, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});
