// ER-R01 第四轮修正反例（对应 Codex 第四轮审阅 W1—W7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const mod = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const { openDb, get, all, run } = require(join(ROOT, 'dist/main/db.js'));
const settingsMod = require(join(ROOT, 'dist/main/settings.js'));

const CRYPTOR = { available: () => true, encrypt: (p) => p, decrypt: (e) => e };

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

// ---------------------------------------------------------------------------
// W1：坏标记两次启动均阻止空库；gate 阻止 openDb
// ---------------------------------------------------------------------------

test('W1 损坏标记：两次启动均 abort 且零建库；gate 阻止 openDb', () => {
  const tmp = join(tmpdir(), `er05-w1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const backup = mod('backup');
    writeFileSync(join(tmp, 'pending-restore.json'), '{broken');
    const d1 = backup.evaluateStartupRestore(tmp);
    assert.equal(d1.action, 'abort', `第一次 ${JSON.stringify(d1)}`);
    const d2 = backup.evaluateStartupRestore(tmp);
    assert.equal(d2.action, 'abort', `第二次必须仍 abort（持久闸门）`);
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false, '零建库');
    // W1：无库 + unresolved 标记 → 第三次启动仍 abort（持久闸门在 evaluate 层而非仅 gate 文件）
    const d3 = backup.evaluateStartupRestore(tmp);
    assert.equal(d3.action, 'abort', '第三次启动仍必须 abort（unresolved 标记持久）');
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false, '仍未建库');
    // gate 协议本身：手动创建 gate → openDb 被阻止
    writeFileSync(join(tmp, 'zhixing.db.restore-gate'), '{}');
    let blocked = false;
    try { mod('db').openDb(join(tmp, 'zhixing.db')); } catch (e) { blocked = String(e.message).includes('恢复'); }
    assert.ok(blocked, 'gate 必须阻止 openDb');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W2：否定句感受不正式化；确认链路（IPC→修订）生效
// ---------------------------------------------------------------------------

test('W2 否定句感受保持待核对；确认后成为正式感受并产生新修订', async () => {
  const tmp = join(tmpdir(), `er05-w2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const seq = [
      () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(JSON.stringify({
        coverage: 'c', experiences: ['我今天没有开心，反而很难过。'], feelings: ['开心'], keep_practices: [],
        open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [],
      })),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { const n = seq.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '我今天没有开心，反而很难过。' });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, true, end.detail);
    await new Promise((r) => setTimeout(r, 120));
    const content = JSON.parse(svc.getToday().latestReport.contentJson);
    assert.deepEqual(content.feelings, [], '否定句中的词不得成为正式感受');
    assert.ok(content.ai_notes.some((n) => n.includes('开心')), '模型归纳保持在待核对');
    assert.deepEqual(content.feelings_confirmed, []);
    // 确认链路：confirmReportFeeling → 新修订
    const reports = mod('reports');
    const latest = svc.getToday().latestReport;
    const r = reports.confirmReportFeeling(db, {
      reportId: latest.id, item: content.ai_notes.find((n) => n.includes('开心')),
      appVersion: '0.1.0', notify: () => undefined,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = JSON.parse(reports.getReport(db, r.report.id).content_json);
    assert.ok(after.feelings.includes('开心'), '确认后进入正式感受');
    assert.ok(after.feelings_confirmed.includes('开心'), '确认记录保留');
    assert.equal(reports.reportsByDate(db, latest.date).length, 2, '确认产生新修订');
    await new Promise((r) => setTimeout(r, 250)); // 等确认触发的导出微任务完成，避免关库后异步活动
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W3：单行超限切分——先断言输入越界，再断言成功且多请求合规
// ---------------------------------------------------------------------------

test('W3 单行 20×400 字经历越界：成功生成、多请求、每请求 <24KiB、条目完整不断裂', async () => {
  const tmp = join(tmpdir(), `er05-w3-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 20 条 × 400 字中文，同一份日报（单行 = 经历拼接行，必然越界）
    const items = Array.from({ length: 20 }, (_, i) => '经历'.padEnd(0) + `第 ${i + 1} 条：` + '长'.repeat(400));
    // 第二天：单条目自身 25KB（触发"单条仍超限 → CodePoint 切片"路径）
    const hugeItem = '巨'.repeat(8400);
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('big', '2025-01-01', 1, 's', ?, 'm', 'v1', 1, '2025-01-01')`,
      JSON.stringify({ coverage: 'c', experiences: items, feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }));
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('huge', '2025-01-02', 1, 's', ?, 'm', 'v1', 1, '2025-01-02')`,
      JSON.stringify({ coverage: 'c', experiences: [hugeItem], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }));
    // 先断言：若不分段，单请求将越界（>24KiB）
    const raw = JSON.stringify({ messages: [{ role: 'system', content: 'x'.repeat(1000) }, { role: 'user', content: items.join('；') }] });
    assert.ok(Buffer.byteLength(raw, 'utf8') > 24 * 1024, '夹具自检：输入确实越界');
    assert.ok(Buffer.byteLength('- 经历：' + hugeItem, 'utf8') > 20 * 1024, '夹具自检：单条目自身越界（触发 CodePoint 切片）');
    const bodies = [];
    const texts = []; // 每个请求的 system+user 全文（用于内容完整性断言）
    const period = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        bodies.push(Buffer.byteLength(init.body, 'utf8'));
        const msgs = JSON.parse(init.body).messages;
        texts.push(msgs.map((m) => m.content).join('\n'));
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    const r = await period.generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-02', label: 'W' });
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    assert.ok(bodies.length >= 2, `应多个请求（实测 ${bodies.length}）`);
    for (const [i, b] of bodies.entries()) assert.ok(b < 24 * 1024, `第 ${i + 1} 请求 ${b} 字节超限`);
    // 内容完整（W3 验收）：20 个条目逐条完整出现在某层请求中（条目不跨片段断裂）
    const allText = texts.join('\n');
    for (const [i, item] of items.entries()) {
      assert.ok(allText.includes(item), `第 ${i + 1} 条经历必须完整出现在某层请求中（不因切分断裂）`);
    }
    // 单条切片无损：按请求顺序重组"巨"片段 = 原条目（顺序切片，拼接还原）
    const giantSlices = [];
    for (const t of texts) {
      for (const m of t.matchAll(/^- 经历：(巨+)$/gm)) giantSlices.push(m[1]);
    }
    assert.equal(giantSlices.join(''), hugeItem, 'CodePoint 切片按顺序拼接必须无损还原原条目');
    // 分段确实发生（片段标记存在）
    assert.ok(/·片段 \d+\/\d+】/.test(allText), '片段索引标记存在');
    assert.equal(r.report.bindings.daily_report_ids.length, 2, '证据索引完整（两份日报都绑定）');
    await new Promise((res) => setTimeout(res, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W4：聚合层检查点续跑——首层摘要真实越界触发分层；聚合 1 成功、2 失败，
// 重试（新服务实例 = 进程重启语义）零重复：首层批与聚合 1 都不再 fetch
// ---------------------------------------------------------------------------

test('W4 聚合层续跑：聚合 1 成功、2 失败 → 重试聚合 1 零重复 fetch', async () => {
  const tmp = join(tmpdir(), `er05-w4-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 2 份大日报 → 首层 2 批；首层批次返回"大摘要"（6×300 字 × 3 字段，约 15KB/份），
    // 两份合并 > 20KiB → 真实触发分层聚合（不能靠"摘要恰好很大"的偶然，夹具自检见下）
    for (let i = 0; i < 2; i++) {
      const big = '摘要内容用于撑体积。'.repeat(400);
      run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES (?, ?, 1, 's', ?, 'm', 'v1', 1, '2025-01-0' || ?)`,
        'd' + i, `2025-01-0${i + 1}`, JSON.stringify({ coverage: 'c', experiences: [big + '（' + i + '）'], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }), String(i + 1));
    }
    const bigField = Array.from({ length: 6 }, (_, k) => `首层要点${k}`.padEnd(300, '详'));
    const bigPartial = { coverage: 'c', highlights: bigField, patterns: bigField, open_questions: bigField };
    // 夹具自检：两份首层摘要的聚合输入文本确实越界（与实现 summarize 同构）
    const sumText = (label, p) => `【${label}】\n值得记下：${p.highlights.join('；') || '（无）'}\n模式：${p.patterns.join('；') || '（无）'}\n待验证：${p.open_questions.join('；') || '（无）'}`;
    assert.ok(
      Buffer.byteLength(sumText('批次 1', bigPartial) + '\n\n' + sumText('批次 2', bigPartial), 'utf8') > 20 * 1024,
      '夹具自检：首层摘要合并确实 >20KiB（否则聚合层不会被触发）',
    );
    let calls = 0;
    let firstAggSeen = 0;
    let layer1Seen = 0;
    let phase = 1; // 1 = 聚合 2/2 失败；2 = 全成功
    const fetchFn = async (_url, init) => {
      calls++;
      const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
      const isAgg = sys.includes('分层聚合');
      const isFinal = sys.includes('最终汇总');
      if (!isAgg && !isFinal) {
        layer1Seen++; // 首层批次请求
        return jsonResp(JSON.stringify(bigPartial));
      }
      const aggIndex = sys.match(/分层聚合 (\d+)\//);
      // W4 反例：第一次运行的第二个聚合请求失败（无论组数）
      const failThis = phase === 1 && aggIndex && Number(aggIndex[1]) === 2;
      if (isAgg && aggIndex && Number(aggIndex[1]) === 1) firstAggSeen++;
      return failThis
        ? { ok: false, status: 500, text: async () => 'boom' }
        : jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
    };
    const mkService = () => mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn, notifyApp: () => undefined,
    });
    const r1 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-02', label: 'W' });
    assert.equal(r1.ok, false, '聚合失败必须整体失败（不发布残缺报告）');
    const callsAfterFirst = calls;
    const layer1AfterFirst = layer1Seen;
    assert.ok(firstAggSeen >= 1, '聚合 1 已发生');
    assert.equal(all(db, `SELECT id FROM period_reports`).length, 0, '零发布');
    // 重试（新服务实例 = 进程重启；检查点在库内）：聚合 1/2 与首层批均零重复 fetch
    phase = 2;
    const r2 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-02', label: 'W' });
    assert.equal(r2.ok, true, r2.detail);
    assert.equal(firstAggSeen, 1, `聚合 1/2 不得重复 fetch（实测 ${firstAggSeen}）`);
    assert.equal(layer1Seen, layer1AfterFirst, `首层批不得重复 fetch（实测 ${layer1Seen}）`);
    assert.ok(calls > callsAfterFirst, '重试只补做 2/2 与最终汇总');
    await new Promise((r) => setTimeout(r, 250)); // 等导出微任务完成
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W4b：最终汇总失败 → 检查点保留；重试零重复（首层批不重 fetch），成功后检查点清除
// ---------------------------------------------------------------------------

test('W4b 最终汇总失败续跑：重试首层零重复 fetch，发布后检查点清除', async () => {
  const tmp = join(tmpdir(), `er05-w4b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('d0', '2025-01-01', 1, 's', ?, 'm', 'v1', 1, '2025-01-01')`,
      JSON.stringify({ coverage: 'c', experiences: ['普通的一天记录'], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }));
    let layer1Seen = 0;
    let phase = 1; // 1 = 最终汇总失败；2 = 成功
    const fetchFn = async (_url, init) => {
      const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
      if (!sys.includes('最终汇总')) {
        layer1Seen++;
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
      }
      if (phase === 1) return { ok: false, status: 500, text: async () => 'boom' };
      return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['ok'], patterns: [], open_questions: [] }));
    };
    const mkService = () => mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn, notifyApp: () => undefined,
    });
    const r1 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r1.ok, false, '最终汇总失败必须整体失败');
    assert.equal(layer1Seen, 1, '首层批已完成一次');
    const ckptKey = `periodic_ckpt:weekly:2025-01-01:2025-01-01`;
    assert.ok(get(db, `SELECT value FROM meta WHERE key = ?`, ckptKey), '失败后检查点保留（可续跑）');
    phase = 2;
    const r2 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r2.ok, true, r2.detail);
    assert.equal(layer1Seen, 1, '重试首层零重复 fetch（检查点续跑）');
    assert.equal(get(db, `SELECT value FROM meta WHERE key = ?`, ckptKey), undefined, '发布成功后检查点清除');
    await new Promise((r) => setTimeout(r, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W5：真实两进程并发（异步 spawn + 交叉 READY 屏障——第五轮审阅指认顺序 spawnSync
// 不是并发；反例必须证明两条输入都进入当前汇总且各恰好一次）
// ---------------------------------------------------------------------------

test('W5 两个独立进程真并发写日报：双方记录保留、各恰好一次、恰好一份当前正式版', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const tmp = join(tmpdir(), `er05-w5-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 初始化库与 schema
    const db0 = openDb(dbPath);
    db0.close();
    // 交叉屏障：每个进程写自己的 ready 文件，等到**对方**的 ready 也出现后同时写入
    const worker = (name, other) => `
      const ROOTP = ${JSON.stringify(ROOT)};
      const { createRequire } = require('node:module');
      const req = createRequire(ROOTP + '/package.json');
      const pathm = require('node:path');
      const toPosix = (p2) => p2.split(pathm.sep).join('/');
      const { openDb } = req(toPosix(ROOTP + '/dist/main/db.js'));
      const { createSessionService } = req(toPosix(ROOTP + '/dist/main/session.js'));
      const settingsMod = req(toPosix(ROOTP + '/dist/main/settings.js'));
      const fs = require('node:fs');
      const db = openDb(${JSON.stringify(dbPath)});
      fs.mkdirSync(${JSON.stringify(join(tmp, 'vault'))}, { recursive: true });
      settingsMod.setPlainSettings(db, { obsidianDir: ${JSON.stringify(join(tmp, 'vault'))}, budgetMonthlyCny: 20 });
      // 交叉屏障：宣告就绪 + 等待对方就绪 → 两个进程的重叠窗口最大化
      fs.writeFileSync(${JSON.stringify(join(tmp, 'ready-'))} + ${JSON.stringify(name)}, '1');
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(${JSON.stringify(join(tmp, 'ready-'))} + ${JSON.stringify(other)}) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      const svc = createSessionService({
        db, promptsBaseDir: ${JSON.stringify(join(ROOT, 'resources'))}, appVersion: '0.1.0',
        cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e },
        fetchFn: async () => ({ ok: true, status: 200, body: { getReader() { return { read() { return Promise.resolve({ done: true }); } }; } } }),
        notifyModel: () => undefined, notifyApp: () => undefined,
      });
      svc.startShort({ content: ${JSON.stringify('写入者 ' + name + ' 的记录')}, mood: 'x' });
      // 等排队中的导出微任务完成后再关库（否则 unhandled rejection 使进程 exit 1）
      setTimeout(() => { console.log('done ' + ${JSON.stringify(name)}); db.close(); }, 300);
    `;
    const w1 = join(tmp, 'w1.js');
    const w2 = join(tmp, 'w2.js');
    writeFileSync(w1, worker('A', 'B'));
    writeFileSync(w2, worker('B', 'A'));
    // 真并发：两个进程同时启动（异步 spawn），屏障释放后才各自写入
    const p1 = spawn(process.execPath, [w1]);
    const p2 = spawn(process.execPath, [w2]);
    let out1 = '';
    let out2 = '';
    p1.stdout.on('data', (d) => { out1 += String(d); });
    p2.stdout.on('data', (d) => { out2 += String(d); });
    const [e1, e2] = await Promise.all([once(p1, 'exit'), once(p2, 'exit')]);
    assert.ok(out1.includes('done A'), `进程 A 输出：${out1}`);
    assert.ok(out2.includes('done B'), `进程 B 输出：${out2}`);
    assert.equal(e1[0], 0, `进程 A 退出码 ${e1[0]}`);
    assert.equal(e2[0], 0, `进程 B 退出码 ${e2[0]}`);
    assert.ok(existsSync(join(tmp, 'ready-A')) && existsSync(join(tmp, 'ready-B')), '双方都通过屏障（真重叠窗口）');
    const db = openDb(dbPath);
    const reports = all(db, `SELECT rev, superseded_by, content_json FROM daily_reports WHERE formal=1 ORDER BY rev`);
    assert.ok(reports.length >= 1, '至少一份正式日报');
    const currents = reports.filter((r) => !r.superseded_by);
    assert.equal(currents.length, 1, '恰好一份当前正式版');
    const latest = JSON.parse(currents[0].content_json);
    const joined = latest.experiences.join('\n');
    assert.ok(joined.includes('写入者 A 的记录'), `当前汇总含 A：${joined.slice(0, 80)}`);
    assert.ok(joined.includes('写入者 B 的记录'), '当前汇总含 B（双方保留）');
    assert.equal(joined.split('写入者 A 的记录').length - 1, 1, 'A 恰好一次（不重复）');
    assert.equal(joined.split('写入者 B 的记录').length - 1, 1, 'B 恰好一次');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W6/F6：旧导出任务 vault_dir 迁移——必须走**真实迁移路径**（第五轮审阅指认：
// 手工插入 UNRESOLVED 跳过了迁移，覆盖不到"v3 已有列但值为 NULL"的真实缺口）
// ---------------------------------------------------------------------------

test('W6 真实迁移 v3→v4：NULL 目标回填 UNRESOLVED；有效目标不动；meta=4；重试明确报错不换目录', async () => {
  const tmp = join(tmpdir(), `er05-w6-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // 1) 用当前代码建库（拿到最新表结构），再**降级模拟**上一版 v3 库的真实状态：
    //    schema_version=3、任务行 vault_dir 为 NULL（旧版尚未写入目标时的持久形态）
    const dbPath = join(tmp, 'zhixing.db');
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    mkdirSync(join(tmp, 'vaultB'), { recursive: true });
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('old-null','daily_report','r1','日报/x.md','h',NULL,'failed',0,'t','t')`);
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('old-bound','daily_report','r2','日报/y.md','h',?,'done',1,'t','t')`, join(tmp, 'vaultA'));
    pre.close();
    // 2) 重新打开 → 真实迁移 v3→v4 运行
    const db = openDb(dbPath);
    assert.equal(get(db, `SELECT value FROM meta WHERE key='schema_version'`).value, '4', 'meta=4');
    assert.ok(existsSync(dbPath + '.pre-migrate-v4.backup'), '迁移前置备份存在');
    const migrated = get(db, `SELECT vault_dir FROM export_tasks WHERE id='old-null'`);
    assert.equal(migrated.vault_dir, 'UNRESOLVED', 'F6 核心：v3/NULL 任务必须经真实迁移标记 UNRESOLVED（不得留 NULL 悄悄回退到设置）');
    const bound = get(db, `SELECT vault_dir FROM export_tasks WHERE id='old-bound'`);
    assert.equal(bound.vault_dir, join(tmp, 'vaultA'), '已绑定任务不被改写');
    // 3) UNRESOLVED 任务重试：明确报错，不悄悄写到后来的设置目录（vaultB）
    const obsidian = mod('obsidian');
    const r = await obsidian.runExportTask(db, 'old-null', '0.1.0');
    assert.equal(r.ok, false);
    assert.ok((r.error ?? '').includes('目标未定'), `明确报错：${r.error}`);
    const wroteB = all(db, `SELECT id FROM export_tasks WHERE id='old-null' AND status='done'`);
    assert.equal(wroteB.length, 0, '重试不悄悄完成到新设置目录');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// F7：UNRESOLVED 解决入口——选择目录 → 绑定任务（持久）→ 零模型重试导出；取消不写状态
// ---------------------------------------------------------------------------

test('F7 绑定目标并导出：持久化到任务、重启后重试仍用该目录、取消/无效目录零写入', async () => {
  const tmp = join(tmpdir(), `er05-f7-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 经真实迁移产生 UNRESOLVED 任务
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s','{"coverage":"c","experiences":["记录一条"],"feelings":[],"keep_practices":[],"open_questions":[],"related_ideas":[],"ai_notes":[],"action_candidates":[],"actions_accepted":[],"fact_sources":[]}','m','v1',1,'2025-01-01')`);
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('t1','daily_report','r1','日报/2025-01-01.md','h',NULL,'failed',0,'t','t')`);
    pre.close();
    const db = openDb(dbPath);
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='t1'`).vault_dir, 'UNRESOLVED');
    const obsidian = mod('obsidian');
    // 取消：不写任务、不写设置
    const canceled = await obsidian.bindTaskTargetAndExport(db, 't1', null, '0.1.0');
    assert.ok(canceled.canceled === true, '取消语义');
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='t1'`).vault_dir, 'UNRESOLVED', '取消后任务不变');
    // 无效目录：明确报错，任务不变
    const bad = await obsidian.bindTaskTargetAndExport(db, 't1', join(tmp, 'no-such-dir'), '0.1.0');
    assert.equal(bad.ok, false);
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='t1'`).vault_dir, 'UNRESOLVED', '无效目录不绑定');
    // 选择有效目录：绑定持久化 + 导出成功（零模型调用由调用路径保证——无 fetchFn 注入）
    const vaultB = join(tmp, 'vaultB');
    mkdirSync(vaultB, { recursive: true });
    const okRun = await obsidian.bindTaskTargetAndExport(db, 't1', vaultB, '0.1.0');
    assert.equal(okRun.ok, true, okRun.error);
    assert.equal(okRun.status, 'done');
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='t1'`).vault_dir, vaultB, '目标持久绑定到任务');
    assert.ok(existsSync(join(vaultB, '日报', '2025-01-01.md')), '文件写入用户选择的目标');
    // 重启（重开连接）后重试：仍用绑定的目录（不随设置漂移）
    db.close();
    const db2 = openDb(dbPath);
    const r2 = await obsidian.retryExportTask(db2, 't1', '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.equal(get(db2, `SELECT vault_dir FROM export_tasks WHERE id='t1'`).vault_dir, vaultB, '重启后绑定不漂移');
    // 已绑定任务不可再改目标
    const reb = await obsidian.bindTaskTargetAndExport(db2, 't1', join(tmp, 'other'), '0.1.0');
    assert.equal(reb.ok, false, '已绑定任务拒绝重绑');
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// W7/F8：整树排除活动 review.md（正则必须匹配 review.md 本身）；反例副本带
// **干净 Git 基线**（复制时排除 .git 后重新 init/add/commit），基线完整通过、
// 等长篡改+清单同步改 → 13 精确失败
// ---------------------------------------------------------------------------

test('W7 干净提交副本上基线全过；整树不含活动 review.md；等长篡改使 13 精确失败', { skip: existsSync(join(ROOT, 'project-state.json')) ? false : '内部流程文件未随公开仓库分发（交接检查器回归需要状态源与 tasks 证据）' }, async () => {
  const tmp = join(tmpdir(), `er05-w7-${Math.random().toString(36).slice(2, 8)}`);
  const { cpSync } = await import('node:fs');
  mkdirSync(tmp, { recursive: true });
  // F8：复制时排除 .git——在源仓库的 .git 上 git init/commit 会得到
  // "nothing to commit"（干净树），测试还没到反例就失败（第五轮审阅实测）
  cpSync(ROOT, tmp, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop();
      return !['.git', 'node_modules', 'release', 'dist', 'logs'].includes(base);
    },
  });
  try {
    // 受控 Git 基线：全新仓库 + 全量提交 → 检查 11/13 需要的真实 git ls-files 环境
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: tmp });
    // 副本的候选/整树登记来自源仓库，其内容已被本轮整改改变——基线必须基于**副本当前内容**
    // 重新冻结（真实 freeze 脚本）+ 按同一聚合规则重建整树清单，才能得到"完整正常基线"。
    execFileSync(process.execPath, [join(tmp, 'scripts/freeze-candidate.mjs'), 'ER-R01'], { cwd: tmp, stdio: 'pipe' });
    const st = JSON.parse(readFileSync(join(tmp, 'project-state.json'), 'utf8'));
    // 用与 handoff-check 检查 13 完全一致的规则重建整树清单
    const excl = (p2) => ['project-state.json', 'CURRENT_STATE.md', 'HANDOFF.md'].includes(p2)
      || /tasks\/[\w-]+\/evidence\//.test(p2) || /tasks\/[\w-]+\/review\.md$/.test(p2);
    const { createHash } = await import('node:crypto');
    const agg = createHash('sha256');
    const entries = [];
    for (const rel of execFileSync('git', ['ls-files'], { cwd: tmp, encoding: 'utf8' }).split('\n').filter(Boolean).filter((p3) => !excl(p3)).sort()) {
      const buf = readFileSync(join(tmp, rel));
      const h = createHash('sha256').update(buf).digest('hex');
      entries.push({ path: rel, bytes: buf.length, sha256: h });
      agg.update(rel + '\n' + buf.length + '\n' + h + '\n');
    }
    const wtHash = 'sha256:' + agg.digest('hex');
    const wtManifest = `tasks/ER-R01/evidence/whole-tree-test.json`;
    writeFileSync(join(tmp, wtManifest), JSON.stringify({ hash: wtHash, algorithm: 'test baseline', file_count: entries.length, files: entries }, null, 2));
    st.worktree_whole = { candidate: wtHash, manifest: wtManifest, file_count: entries.length, frozen_at: new Date().toISOString(), acceptance: 'test baseline' };
    writeFileSync(join(tmp, 'project-state.json'), JSON.stringify(st, null, 2));
    // 状态源变了 → 重新渲染生成文件（否则检查 10 失效）
    execFileSync(process.execPath, [join(tmp, 'scripts/render-state.mjs')], { cwd: tmp, stdio: 'pipe' });
    const wt = st.worktree_whole;
    // 基线：干净提交副本 + 重新冻结后，交接检查必须**全部通过**（exit=0）
    let r0;
    try {
      r0 = { code: 0, out: execFileSync(process.execPath, [join(tmp, 'scripts/handoff-check.mjs')], { encoding: 'utf8', cwd: tmp }) };
    } catch (e) {
      r0 = { code: e.status, out: (e.stdout ?? '') + String(e) };
    }
    assert.equal(r0.code, 0, `干净基线必须通过（exit=${r0.code}）：\n${r0.out.slice(-1200)}`);
    assert.ok(r0.out.includes('13 项检查，13 通过'), '基线 13/13');
    // 整树清单不包含活动 review.md（F8 修正后的精确正则）
    const mf = JSON.parse(readFileSync(join(tmp, wt.manifest), 'utf8'));
    assert.ok(!mf.files.some((f) => /tasks\/[\w-]+\/review\.md$/.test(f.path)), '活动 review.md 不在整树清单');
    // 反例：等长篡改 + 同步改单文件清单 sha256 → 13 因聚合绑定内容而失败（exit=1）
    const target = mf.files.find((f) => f.path === 'README.md');
    const buf = readFileSync(join(tmp, 'README.md'));
    buf[0] = buf[0] ^ 0x20;
    writeFileSync(join(tmp, 'README.md'), buf);
    target.sha256 = createHash('sha256').update(buf).digest('hex');
    writeFileSync(join(tmp, wt.manifest), JSON.stringify(mf, null, 2));
    let r1;
    try {
      r1 = { code: 0, out: execFileSync(process.execPath, [join(tmp, 'scripts/handoff-check.mjs')], { encoding: 'utf8', cwd: tmp }) };
    } catch (e) {
      r1 = { code: e.status, out: (e.stdout ?? '') + String(e) };
    }
    assert.equal(r1.code, 1, '反例必须失败');
    assert.ok(/✗ 13/.test(r1.out), `必须精确报 ✗ 13：${r1.out.slice(-500)}`);
  } finally {
    rmTmp(tmp);
  }
});
