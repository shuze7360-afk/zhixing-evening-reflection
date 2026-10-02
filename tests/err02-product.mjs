// ER-R01 反例测试：R6—R9（产品逻辑与并发）。
// 修复前对应项失败（before 证据 evidence/03），修复后应全部通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

function sse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader() { return { read() { if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) }); return Promise.resolve({ done: true }); } }; } },
  };
}
function jsonResp(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), text: async () => '' };
}

function makeSvc(tmp, responses, opts = {}) {
  const db = openDb(join(tmp, 'a.db'));
  mkdirSync(join(tmp, 'vault'), { recursive: true });
  settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
  const events = [];
  const svc = mod('session').createSessionService({
    db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
    fetchFn: async () => { const n = responses.shift(); if (!n) throw new Error('no more'); return typeof n === 'function' ? n() : n; },
    notifyModel: (e) => events.push(['m', e.type, e.errorClass ?? '', e.error ?? '']),
    notifyApp: (e) => events.push(['a', e.type, e.status ?? '']),
    ...opts,
  });
  return { db, svc, events };
}

// ---------------------------------------------------------------------------
// R6：思想依据与伪造拦截
// ---------------------------------------------------------------------------

test('R6-a 上下文随原则卡启停变化；伪造 principle_id 降级为待核对，不进正式相关思想', async () => {
  const tmp = join(tmpdir(), `err02-r6a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const { seedPrinciples, listPrinciples, setCardEnabled } = mod('principles');
    seedPrinciples(db, join(ROOT, 'resources'));
    const card = listPrinciples(db).find((c) => c.quoteOriginal.includes('say no to everything'));
    let seenSystem = '';
    const bodies = [];
    const mk = () => sse(['data: {"choices":[{"delta":{"content":"收到"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']);
    const refineResp = (fake) => jsonResp(JSON.stringify({
      coverage: 'c',
      experiences: fake ? ['编造的海外旅行', '我还推掉了一个临时请求'] : ['今天修好了耳机'],
      feelings: [],
      keep_practices: [], open_questions: [],
      related_ideas: [{ idea: 'X 原则', principle_id: fake ? 'fabricated:xxx' : 'naval-batch1:focus-say-no', kind: '解读' }],
      ai_notes: [], action_candidates: [], actions_accepted: [],
    }));
    // 序列：send1→mk；refine1→干净 refine；send2→mk；refine2→伪造 refine
    let lastBody = '';
    const responses = [mk, () => refineResp(false), mk, () => refineResp(true)];
    const { svc } = (() => {
      mkdirSync(join(tmp, 'vault'), { recursive: true });
      settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
      const svc2 = mod('session').createSessionService({
        db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
        fetchFn: async (_url, init) => { lastBody = init.body; const n = responses.shift(); return n(); },
        notifyModel: () => undefined, notifyApp: () => undefined,
      });
      return { svc: svc2 };
    })();
    return (async () => {
      // —— 上下文随启停变化：未启用时不含卡，启用后新会话上下文含卡与 id ——
      const s0 = svc.startChat();
      const sid = s0.snapshot.session.id;
      await svc.send({ sessionId: sid, content: '今天修好了耳机，很有成就感。' });
      const sysBefore = JSON.parse(lastBody).messages.find((m) => m.role === 'system').content;
      assert.ok(!sysBefore.includes('say no to everything'), '未启用原则卡不得出现在上下文');
      const en = setCardEnabled(db, card.id, true);
      assert.equal(en.ok, true, en.error);
      // 先收束当天会话，再开新会话验证上下文
      const end1 = await svc.endSession(sid);
      assert.equal(end1.ok, true, 'endSession1=' + JSON.stringify(end1));
      await new Promise((r) => setTimeout(r, 150));
      const s1 = svc.startChat();
      const sid2 = s1.snapshot.session.id;
      assert.notEqual(sid2, sid, '已收束后应开新会话');
      await svc.send({ sessionId: sid2, content: '我还推掉了一个临时请求。' });
      const sysAfter = JSON.parse(lastBody).messages.find((m) => m.role === 'system').content;
      assert.ok(sysAfter.includes('say no to everything'), '启用后原则卡应进入上下文');
      assert.ok(sysAfter.includes(card.id), '上下文必须带 principle_id');
      void seenSystem;
      // —— 伪造拦截：伪造经历/伪造卡被降级（结束第二个会话，mock 返回伪造内容）——
      const end = await svc.endSession(sid2);
      assert.equal(end.ok, true, 'endSession=' + JSON.stringify(end));
      await new Promise((r) => setTimeout(r, 150));
      const rep = svc.getToday().latestReport;
      const content = JSON.parse(rep.contentJson);
      assert.ok(content.experiences.every((e) => e.includes('临时请求')), '编造经历不得正式化');
      // 第二个 refine 的 related_ideas 只含伪造卡 → 全部降级，正式相关思想为空（正确行为）
      assert.equal(content.related_ideas.length, 0, '伪造卡不得进相关思想');
      // 合法卡来源程序生成已在第一次 refine 验证：
      const firstContent = JSON.parse(mod('reports').viewReports(mod('reports').reportsByDate(db, svc.getToday().latestReport.date)).find((r) => r.rev === 1).contentJson);
      assert.equal(firstContent.related_ideas.length, 1, '合法卡保留');
      assert.equal(firstContent.related_ideas[0].principle_id, 'naval-batch1:focus-say-no');
      assert.ok(firstContent.related_ideas[0].source.includes('naval-batch1:focus-say-no'), '来源文字由程序生成');
    })();
  } finally {
    rmTmp(tmp);
  }
});

test('R6-c 启用校验：无定位/快照缺失的卡不得启用；草稿可补全后启用', () => {
  const tmp = join(tmpdir(), `err02-r6c-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const { addDraftCard, updateDraftCard, setCardEnabled } = mod('principles');
    const draft = addDraftCard(db, { text: '我自己的原则：先完成再完美', origin: 'suggestion' });
    // 缺定位 → 拒绝启用
    const r1 = setCardEnabled(db, draft.id, true);
    assert.equal(r1.ok, false, '缺定位不得启用');
    // 补全后可启用
    updateDraftCard(db, draft.id, { position: '[个人建议] 导入·suggestion', interpretation: '降低启动阻力', boundary: '适用于长期项目' });
    const r2 = setCardEnabled(db, draft.id, true);
    assert.equal(r2.ok, true, r2.error);
    // 快照缺失的卡拒绝
    run(db, `INSERT INTO principle_cards (id, quote_en, source_url, snapshot_id, position, explanation_cn, boundary, enabled, created_at)
             VALUES ('bad-snap', 'x', NULL, 'no-such-snap', 'pos', '', '', 0, '2026-01-01')`);
    const r3 = setCardEnabled(db, 'bad-snap', true);
    assert.equal(r3.ok, false, '快照缺失不得启用');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// R7：追问上限
// ---------------------------------------------------------------------------

test('R7 连续 Q1/Q2/Q3：第三问不得展示；跳过后不再追问', async () => {
  const tmp = join(tmpdir(), `err02-r7-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const responses = [
      () => sse(['data: {"choices":[{"delta":{"content":"反馈1"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"\\n【追问】Q1？"}}]}\n\n', 'data: [DONE]\n\n']),
      () => sse(['data: {"choices":[{"delta":{"content":"反馈2"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"\\n【追问】Q2？"}}]}\n\n', 'data: [DONE]\n\n']),
      // 已达上限，模型仍返回 Q3：进入界面前必须剥离
      () => sse(['data: {"choices":[{"delta":{"content":"反馈3"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"\\n【追问】Q3？"}}]}\n\n', 'data: [DONE]\n\n']),
    ];
    const { svc } = makeSvc(tmp, responses);
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '回答零' });
    let snap = svc.getToday();
    assert.equal(snap.session.phase, 'followup');
    assert.ok(snap.messages[1].content.includes('Q1'));
    await svc.send({ sessionId: sid, content: '回答一' });
    snap = svc.getToday();
    assert.equal(snap.session.followupUsed, 2, '追问计数达上限');
    assert.ok(snap.messages.at(-1).content.includes('Q2'));
    // 用户回答第二个问题后 → 收束轮；模型仍返回 Q3，必须被剥离
    await svc.send({ sessionId: sid, content: '回答二' });
    snap = svc.getToday();
    assert.equal(snap.session.phase, 'wrapup');
    const lastMsg = snap.messages.at(-1);
    assert.ok(!lastMsg.content.includes('Q3'), '达到上限后第三问不得展示');
    assert.equal(snap.session.followupUsed, 2, '计数不得突破上限');
    // 跳过（wrapup 阶段 skip 应拒绝）→ 不再有追问
    const skip = await svc.skipFollowup(sid);
    assert.equal(skip.ok, false, '非追问阶段跳过应拒绝');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// R8：同日归并 + 分批
// ---------------------------------------------------------------------------

test('R8-a 同日两次简短记录：归并为一份最新汇总（旧版 superseded 可查），日期内容不丢', async () => {
  const tmp = join(tmpdir(), `err02-r8a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const { db, svc } = makeSvc(tmp, []);
    const r1 = svc.startShort({ content: '上午写完报告初稿。', mood: '还行' });
    assert.equal(r1.ok, true);
    const r2 = svc.startShort({ content: '下午给花浇了水。', mood: '平静' });
    assert.equal(r2.ok, true);
    await new Promise((r) => setTimeout(r, 300));
    const snap = svc.getToday();
    assert.ok(snap.latestReport, '有最新日报');
    const content = JSON.parse(snap.latestReport.contentJson);
    assert.ok(content.experiences.some((e) => e.includes('上午写完报告初稿')), '第一条不丢');
    assert.ok(content.experiences.some((e) => e.includes('下午给花浇了水')), '第二条并入');
    assert.equal(content.experiences.length, 2, '不重复计数');
    assert.equal(snap.latestReport.rev, 2, '形成新修订');
    // 旧版仍可查且被替代
    const reports = mod('reports').viewReports(mod('reports').reportsByDate(db, snap.latestReport.date));
    assert.equal(reports.length, 2, '旧版保留');
    assert.ok(reports.some((r) => r.supersededBy), '存在被替代的旧版');
    assert.equal(reports.find((r) => !r.supersededBy).rev, 2, '最新版 rev=2 未被替代');
  } finally {
    rmTmp(tmp);
  }
});

test('R8-b 周期报告分批：365 份日报单次输入不超限、日期不重复计数', async () => {
  const tmp = join(tmpdir(), `err02-r8b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 造 365 份日报（每天约 120 字 → 总量远超 24KiB）
    const ins = db.prepare(
      `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
       VALUES (?, ?, 1, 's', ?, 'm', 'v1', 1, '2026-01-01')`,
    );
    const year = [];
    const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < 365; i++) {
      const d = new Date(2025, 0, 1 + i);
      const date = localDate(d);
      year.push({ coverage: 'c', experiences: [`第 ${i + 1} 天：记录一条不算太短的当天经历内容，确保总体积超过单次上限。`], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] });
      ins.run('d' + i, date, JSON.stringify(year[i]));
    }
    let lastBody = '';
    const fetchCalls = [];
    const period = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        lastBody = init.body;
        fetchCalls.push(Buffer.byteLength(init.body, 'utf8'));
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [] }));
      },

      notifyApp: () => undefined,
    });
    const r = await period.generate({ kind: 'yearly', start: '2025-01-01', end: '2025-12-31', label: '年报 2025' });
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    assert.equal(r.report.bindings.daily_report_ids.length, 365, '证据索引绑定全部 365 份');
    // coverage 按不同日期统计
    void r;
    // B4 真分批后：批次分隔标记不再拼接进单请求——改验"多请求 + 单请求 <24KiB"
    assert.ok(fetchCalls.length >= 2, `超限输入应分批为多次请求（实测 ${fetchCalls.length}）`);
    for (const [i, size] of fetchCalls.entries()) {
      assert.ok(size < 24 * 1024, `第 ${i + 1} 次请求 ${size} 字节超限`);
    }
    const sys = JSON.parse(lastBody).messages.find((m) => m.role === 'system').content;
    assert.ok(/覆盖 365 个不同日期/.test(sys), 'coverage 按不同日期统计');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// R9：并发
// ---------------------------------------------------------------------------

test('R9-a 两进程同时创建实验：只成功一个（数据库唯一约束仲裁）', async () => {
  const tmp = join(tmpdir(), `err02-r9a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // 预置：先有一个 running（占坑），第二连接再创建 running 应被唯一索引拒绝
    const db1 = openDb(join(tmp, 'a.db'));
    const expArgs = {
      hypotheses: ['A', 'B', 'C'], keyIndex: 0, action: 'x', periodDays: 3, firstStep: 'y',
    };
    const r = mod('experiments').createExperiment(db1, expArgs);
    assert.equal(r.ok, true);
    // 第二个连接指向同一库
    const db2 = openDb(join(tmp, 'a.db'));
    const r2 = mod('experiments').createExperiment(db2, expArgs);
    assert.equal(r2.ok, false, '第二个 running 必须失败');
    assert.equal(r2.error, 'active_exists');
    db1.close(); db2.close();
  } finally {
    rmTmp(tmp);
  }
});

test('R9-b 迁移 v2：既有双 running 被去重、唯一索引生效、数据不破坏', () => {
  const tmp = join(tmpdir(), `err02-r9b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // 构造 v1 库（schema_version=1，双 running，重复提醒）
    const dbPath = join(tmp, 'zhixing.db');
    const db = openDb(dbPath);
    run(db, `UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
    // 移除 v2 索引（openDb 建过）
    db.exec(`DROP INDEX IF EXISTS idx_experiments_single_running; DROP INDEX IF EXISTS idx_reminders_date;`);
    run(db, `INSERT INTO experiments (id, hypothesis, action, period_days, status, first_step, created_at) VALUES ('e1','h','a',3,'running','s','2026-01-01')`);
    run(db, `INSERT INTO experiments (id, hypothesis, action, period_days, status, first_step, created_at) VALUES ('e2','h','a',3,'running','s','2026-01-02')`);
    run(db, `INSERT INTO reminders (id, date, sent_at, seen, channel) VALUES ('r1','2026-01-01','x',0,'n')`);
    run(db, `INSERT INTO reminders (id, date, sent_at, seen, channel) VALUES ('r2','2026-01-01','x',0,'n')`);
    db.close();
    // 重新打开 → 迁移应执行
    const db2 = openDb(dbPath);
    const running = all(db2, `SELECT id FROM experiments WHERE status='running'`);
    assert.equal(running.length, 1, '双 running 去重为 1');
    const concluded = get(db2, `SELECT COUNT(*) AS n FROM experiments WHERE status='concluded'`).n;
    assert.equal(concluded, 1, '被去重的实验留痕为 concluded');
    const rem = all(db2, `SELECT id FROM reminders WHERE date='2026-01-01'`);
    assert.equal(rem.length, 1, '提醒按日去重');
    const v = get(db2, `SELECT value FROM meta WHERE key='schema_version'`).value;
    assert.equal(v, '4', 'schema 升到最新版本');
    // 唯一索引真的在
    const idx = get(db2, `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_experiments_single_running'`);
    assert.ok(idx, '唯一索引存在');
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});

test('R9-c 提醒原子认领：两进程同日只成功一次', () => {
  const tmp = join(tmpdir(), `err02-r9c-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db1 = openDb(join(tmp, 'a.db'));
    const db2 = openDb(join(tmp, 'a.db'));
    const reminders = mod('reminders');
    const now = new Date(2026, 9, 1, 22, 0);
    const cfg = { enabled: true, start: '21:30', end: '23:00' };
    const d1 = reminders.decideReminder(db1, now, cfg);
    assert.deepEqual(d1, { action: 'notify' }, '第一个进程认领成功');
    const d2 = reminders.decideReminder(db2, now, cfg);
    assert.deepEqual(d2, { action: 'none', reason: 'already_attempted' }, '第二个进程不得重复催促');
    db1.close(); db2.close();
  } finally {
    rmTmp(tmp);
  }
});
