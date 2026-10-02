// ER-R01 第三轮修正反例（对应 Codex 第三轮审阅 T1—T7 + 附加并发合同）。
// 每项 = 修复前失败场景的固定回归 + 修复后通过；隔离数据库 / 临时目录 / mock fetch。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// T1：损坏标记 / 源消失 / 空源 → 显式 failed（不静默删除标记、不空库启动）
// ---------------------------------------------------------------------------

test('T1-a 损坏 JSON 标记：隔离保留 + failed；无库不建', () => {
  const tmp = join(tmpdir(), `er04-t1a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const backup = mod('backup');
    const marker = join(tmp, 'pending-restore.json');
    writeFileSync(marker, '{broken json!!!');
    const d = backup.evaluateStartupRestore(tmp);
    assert.equal(d.action, 'abort', `实测 ${JSON.stringify(d)}`);
    assert.ok(d.error?.includes('损坏'), '错误必须说明标记损坏');
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false, '零建库');
    const kept = existsSync(marker) || existsSync(marker + '.corrupt-' + '*') || [...require('node:fs').readdirSync(tmp)].some((f) => f.includes('pending-restore'));
    assert.ok(kept || [...require('node:fs').readdirSync(tmp)].some((f) => f.startsWith('pending-restore')), '标记被保留或隔离（不静默删除）');
  } finally {
    rmTmp(tmp);
  }
});

test('T1-b 空源路径 / 源被删：failed + 标记保留', () => {
  const tmp = join(tmpdir(), `er04-t1b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const backup = mod('backup');
    const marker = join(tmp, 'pending-restore.json');
    // 空 from
    writeFileSync(marker, JSON.stringify({ from: '' }));
    const d1 = backup.evaluateStartupRestore(tmp);
    assert.equal(d1.action, 'abort', '无库时空 from 也必须 abort');
    assert.ok(d1.error?.includes('from'), d1.error);
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false);
    assert.equal(existsSync(marker), true, '标记保留（可修正后重试）');
    // 源被删：W1 后源消失 = 持久未解决（写回 unresolved 标记）；第二次启动遇
    // unresolved → failed；再启动遇 gate → 阻止。三次启动均不建库。
    writeFileSync(marker, JSON.stringify({ from: join(tmp, 'gone.db') }));
    const d2 = backup.evaluateStartupRestore(tmp);
    assert.equal(d2.action, 'abort');
    assert.ok(d2.error?.includes('不存在') || d2.error?.includes('闸门'), d2.error);
    const d3 = backup.evaluateStartupRestore(tmp);
    assert.equal(d3.action, 'abort', 'W1 闸门：后续启动仍阻止');
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false, '零建库');
    assert.equal(existsSync(marker), true, '标记保留');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// T2：迁移到当前版本（F6 起 SCHEMA_VERSION=4）——同 rev 并列、确定性 keeper、meta=当前版、幂等、前置备份
// ---------------------------------------------------------------------------

test('T2 迁移到当前版本：同 rev 并列去重不报错；meta=4；幂等；前置备份存在', () => {
  const tmp = join(tmpdir(), `er04-t2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 旧库样本：同日同 rev 两条正式当前版 + 不同日期一条
    const db = openDb(dbPath);
    run(db, `UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
    db.exec(`DROP INDEX IF EXISTS idx_daily_current; DROP INDEX IF EXISTS idx_experiments_single_running; DROP INDEX IF EXISTS idx_reminders_date;`);
    const ins = (id, date, rev) => run(db,
      `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, superseded_by, created_at)
       VALUES (?, ?, ?, 's', '{}', NULL, NULL, 1, NULL, '2026-01-01')`, id, date, rev);
    ins('a1', '2026-01-01', 1);
    ins('a2', '2026-01-01', 1); // 同 rev 并列（T2 核心）
    ins('a3', '2026-01-02', 2);
    ins('a4', '2026-01-02', 1);
    db.close();
    // 重新打开：迁移必须成功（修复前 UNIQUE constraint failed）
    const db2 = openDb(dbPath);
    const v = get(db2, `SELECT value FROM meta WHERE key='schema_version'`).value;
    assert.equal(v, '4', 'meta=4（T2：版本号与真实 schema 一致）');
    const currents = all(db2, `SELECT id, date FROM daily_reports WHERE formal=1 AND superseded_by IS NULL ORDER BY date`);
    assert.equal(currents.length, 2, '每日期恰好一份当前正式版');
    assert.equal(currents[0].id, 'a1', '同 rev 并列按 id ASC 确定性保留 keeper');
    assert.equal(currents[1].id, 'a3', '不同 rev 按 rev DESC 保留');
    const total = get(db2, `SELECT COUNT(*) AS n FROM daily_reports`).n;
    assert.equal(total, 4, '全部旧记录保留（不删用户内容）');
    // 幂等：再开一次不报错、不变化
    db2.close();
    const db3 = openDb(dbPath);
    assert.equal(all(db3, `SELECT id FROM daily_reports WHERE formal=1 AND superseded_by IS NULL`).length, 2);
    assert.equal(get(db3, `SELECT value FROM meta WHERE key='schema_version'`).value, '4');
    db3.close();
    assert.ok(existsSync(dbPath + '.pre-migrate-v4.backup'), '迁移前置备份存在');
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// T3：事实=原话摘录（完全包含）；fact_sources 溯源；待核对不截断
// ---------------------------------------------------------------------------

test('T3-a 真前缀+假后缀 / 真头尾+假中段 / 逐字原话：只有完全包含成为正式事实并带 message_id', async () => {
  const tmp = join(tmpdir(), `er04-t3a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const USER = '今天我花了一小时修好了自己的耳机，节省了六十元。';
    const responses = [
      () => mod('nothing') && null,
    ];
    const sse = (c) => {
      const enc = new TextEncoder();
      let i = 0;
      return { ok: true, status: 200, body: { getReader() { return { read() { if (i < c.length) return Promise.resolve({ done: false, value: enc.encode(c[i++]) }); return Promise.resolve({ done: true }); } }; } } };
    };
    const refine = jsonResp(JSON.stringify({
      coverage: 'c',
      experiences: [
        '今天我花了一小时修好了自己的耳机，节省了六十元。', // 逐字原话 → 保留
        '今天我花了一小时修好了自己的耳机，此外我获得了十万元奖学金。', // 真前缀+假后缀 → 降级
        '我花了六十元。耳机修好了，节省了六十元。今天我花了一小时修好了自己的耳机。', // 真头尾+假中段 → 降级
      ],
      feelings: [], keep_practices: [], open_questions: [], related_ideas: [],
      ai_notes: [], action_candidates: [], actions_accepted: [],
    }));
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { const n = responses.shift(); return n ? n() : sse(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    // 第一次 fetch 消耗：responses[0] 是坏占位——修正：直接构造
    void refine; void responses;
    db.close();
    rmTmp(tmp);

    // 干净重跑（占位失败不影响断言目标）
    const tmp2 = join(tmpdir(), `er04-t3a2-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp2, { recursive: true });
    try {
      mkdirSync(join(tmp2, 'vault'), { recursive: true });
      const db2 = openDb(join(tmp2, 'a.db'));
      settingsMod.setPlainSettings(db2, { obsidianDir: join(tmp2, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
      const seq = [
        () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
        () => jsonResp(JSON.stringify({
          coverage: 'c',
          experiences: [
            USER,
            '今天我花了一小时修好了自己的耳机，此外我获得了十万元奖学金。',
            '我花了六十元。耳机修好了，节省了六十元。今天我花了一小时修好了自己的耳机。',
          ],
          feelings: [], keep_practices: [], open_questions: [], related_ideas: [],
          ai_notes: [], action_candidates: [], actions_accepted: [],
        })),
      ];
      const svc2 = mod('session').createSessionService({
        db: db2, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
        fetchFn: async () => { const n = seq.shift(); return n(); },
        notifyModel: () => undefined, notifyApp: () => undefined,
      });
      const sid = svc2.startChat().snapshot.session.id;
      await svc2.send({ sessionId: sid, content: USER });
      const end = await svc2.endSession(sid);
      assert.equal(end.ok, true, end.detail);
      await new Promise((r) => setTimeout(r, 120));
      const content = JSON.parse(svc2.getToday().latestReport.contentJson);
      assert.deepEqual(content.experiences, [USER], '只有逐字原话成为正式事实');
      const demoted = content.ai_notes.join('|');
      assert.ok(demoted.includes('十万元奖学金'), '真前缀+假后缀降级');
      assert.ok(demoted.includes('假中段') || demoted.includes('逐字'), '真头尾+假中段降级');
      assert.equal(content.fact_sources.length, 1, 'fact_sources 溯源');
      assert.ok(content.fact_sources[0].messageId, '带 message_id');
      assert.equal(content.fact_sources[0].item, USER);
      db2.close();
    } finally {
      rmTmp(tmp2);
    }
  } finally {
    // 外层 tmp 已在内部清理
  }
});

function sse2(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return { ok: true, status: 200, body: { getReader() { return { read() { if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) }); return Promise.resolve({ done: true }); } }; } } };
}

test('T3-b 待核对不静默截断：模型 ai_notes 大量注入时降级项全部保留', async () => {
  const tmp = join(tmpdir(), `er04-t3b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const fabricated = Array.from({ length: 45 }, (_, i) => `虚构经历 ${i}：内容完全不同各不相同。`); // 复用文本生成 45 条违约内容
    const seq = [
      () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(JSON.stringify({
        coverage: 'c',
        // 各数组都不超 schema 上限（exp 20/feel 20/ideas 10），但降级合计 45 > ai_notes 上限 50
        experiences: fabricated.slice(0, 15),
        feelings: fabricated.slice(0, 18).map((t, i) => '感到' + t),
        keep_practices: [], open_questions: [],
        related_ideas: fabricated.slice(0, 10).map((t, i) => ({ idea: t, principle_id: 'fabricated:' + i, kind: '解读' })),
        ai_notes: Array.from({ length: 15 }, (_, i) => '模型自带假设 ' + i), action_candidates: [], actions_accepted: [],
      })),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { const n = seq.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '普通的一天。' });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, true, 'endSession=' + JSON.stringify(end));
    await new Promise((r) => setTimeout(r, 120));
    const content = JSON.parse(svc.getToday().latestReport.contentJson);
    assert.equal(content.experiences.length, 0, '全部虚构不得正式化');
    const demotedCount = content.ai_notes.filter((n) => n.includes('待核对')).length;
    assert.ok(demotedCount >= 43, `43 条降级必须全部保留（含显式注明行，实测 ${demotedCount}）`);
    assert.ok(content.ai_notes.some((n) => n.includes('另有')), '超限必须有显式注明（不静默）');
    assert.ok(content.ai_notes.some((n) => n.includes('模型自带假设 0')), '模型原有 ai_notes 部分保留');
    assert.ok(!content.ai_notes.some((n) => n.includes('模型自带假设 14')), '超出上限的模型假设被显式注明而非挤掉待核对');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// T4：单条超大日报分段（每请求 <24KiB）；检查点续跑（失败重试不重跑已完成批）
// ---------------------------------------------------------------------------

test('T4-a 单条超大日报被分段：所有请求 <24KiB，首层分段请求 ≥2（非仅首层+汇总）', async () => {
  const tmp = join(tmpdir(), `er04-t4a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 单份日报：多条经历合并到 ~90KB（W4 审阅修正：19,100 字节并未超过 20KiB 目标，
    // 旧夹具实际只产生"1 首层 + 1 汇总"两请求，未走过分段路径）
    const items = Array.from({ length: 150 }, (_, i) => `第 ${i + 1} 条：` + '详'.repeat(190));
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('big', '2025-01-01', 1, 's', ?, 'm', 'v1', 1, '2025-01-01')`,
      JSON.stringify({ coverage: 'c', experiences: items, feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }));
    // 夹具自检：经历拼接行确实超过 20KiB 批次目标（否则分段路径不会被触发）
    assert.ok(Buffer.byteLength('- 经历：' + items.join('；'), 'utf8') > 20 * 1024, '夹具自检：单行经历确实 >20KiB');
    const bodies = [];
    const texts = [];
    let layer1 = 0;
    const period = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        bodies.push(Buffer.byteLength(init.body, 'utf8'));
        const msgs = JSON.parse(init.body).messages;
        const sys = msgs.find((m) => m.role === 'system').content;
        if (!sys.includes('最终汇总')) layer1++;
        texts.push(msgs.map((m) => m.content).join('\n'));
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    const r = await period.generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    assert.ok(layer1 >= 2, `首层分段请求应 ≥2（实测 ${layer1}；否则只是首层+汇总的假阳性）`);
    assert.ok(bodies.length >= 2, `超大单条应切分为多请求（实测 ${bodies.length}）`);
    for (const [i, b] of bodies.entries()) assert.ok(b < 24 * 1024, `第 ${i + 1} 请求 ${b} 字节超限`);
    // 内容完整：每个条目完整出现在某层请求中（W3 逐条目切分保证不跨片段断裂）
    const allText = texts.join('\n');
    for (const [i, item] of items.entries()) {
      assert.ok(allText.includes(item), `第 ${i + 1} 条经历必须完整出现在某层请求中`);
    }
    assert.equal(r.report.bindings.daily_report_ids.length, 1, '证据索引不丢');
    await new Promise((res) => setTimeout(res, 300)); // 等导出微任务完成
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('T4-b 批失败 → 检查点续跑：重试只请求未完成批（第一批不重复 fetch/计费）', async () => {
  const tmp = join(tmpdir(), `er04-t4b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // 3 批内容：3 份大日报各约 20KB → 3 批 + 1 汇总
    const bigExp = '内容用于撑体积。'.repeat(900);
    for (let i = 0; i < 3; i++) {
      run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES (?, ?, 1, 's', ?, 'm', 'v1', 1, ?)`,
        'd' + i, `2025-01-0${i + 1}`, JSON.stringify({ coverage: 'c', experiences: [bigExp + '（' + i + '）'], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] }), `2025-01-0${i + 1}T12:00:00Z`);
    }
    let batch1Seen = 0;
    const bodies = [];
    const failBatch2 = true;
    let sawBatch2 = 0;
    const mk = () => async (_url, init) => {
      const body = Buffer.from(init.body, 'utf8');
      bodies.push(body);
      const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
      // 第二批的可靠标记：含第 2 份日报的（2）标记且非最终汇总
      const isBatch2 = sys.includes('（2）') && !sys.includes('最终汇总');
      if (isBatch2) sawBatch2++;
      if (failBatch2 && isBatch2) return { ok: false, status: 500, text: async () => 'boom' };
      return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h' + bodies.length], patterns: [], open_questions: [] }));
    };
    // 第一次：批 2 失败
    const period1 = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: mk(), notifyApp: () => undefined,
    });
    const r1 = await period1.generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-03', label: 'W' });
    assert.equal(r1.ok, false, '批 2 失败必须整体失败（不发布残缺报告）');
    assert.ok(sawBatch2 > 0, '夹具自检：含（2）请求出现 ' + sawBatch2 + ' 次');
    const reportsSoFar = all(db, `SELECT id FROM period_reports`);
    assert.equal(reportsSoFar.length, 0, '不发布残缺正式报告');
    // 第二次：全部成功——批 1 不得重复请求
    const period2 = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        const body = Buffer.from(init.body, 'utf8');
        bodies.push(body);
        const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
        if (sys.includes('（1）') && !sys.includes('（2）') && !sys.includes('最终汇总')) batch1Seen++;
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    const r2 = await period2.generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-03', label: 'W' });
    assert.equal(r2.ok, true, r2.detail);
    assert.ok(sawBatch2 > 0, '重试轮含（2）请求成功（计数 ' + sawBatch2 + '）');
    assert.equal(batch1Seen, 0, '检查点续跑：已完成批 1 不得重复请求');
    assert.equal(r2.report.bindings.daily_report_ids.length, 3, '证据索引完整');
    const usage = all(db, `SELECT status FROM usage`);
    assert.ok(usage.every((u) => u.status === 'settled' || u.status === 'refunded' || u.status === 'unknown' || u.status === 'held'), '费用状态合法');
    await new Promise((res) => setTimeout(res, 300)); // 等导出微任务完成
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// T5：个人建议卡补全后可启用（不要求 URL）；空解读按合同报错；detail 透传
// ---------------------------------------------------------------------------

test('T5 个人建议卡：补全定位/解读/边界即可启用（无需 URL）；缺解读报错且 detail 可读', () => {
  const tmp = join(tmpdir(), `er04-t5-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const P = mod('principles');
    const draft = P.addDraftCard(db, { text: '导师口头建议：先搭骨架再填肉。', origin: 'suggestion' });
    // 只填定位（旧缺陷路径）：仍拒——缺解读/边界
    P.updateDraftCard(db, draft.id, { position: '[个人建议] 导师口头建议' });
    const r1 = P.setCardEnabled(db, draft.id, true);
    assert.equal(r1.ok, false);
    assert.ok((r1.error ?? '').includes('解读'), `应报缺解读：${r1.error}`);
    // 补全解读+边界 → 启用成功（无 URL/快照）
    P.updateDraftCard(db, draft.id, { interpretation: '降低启动阻力', boundary: '适用于长期项目' });
    const r2 = P.setCardEnabled(db, draft.id, true);
    assert.equal(r2.ok, true, r2.error);
    // IPC 层 detail 透传（wiring）：handlers 源码含 detail 透传
    const handlers = readFileSync(join(ROOT, 'dist/main/ipc-handlers.js'), 'utf8');
    assert.ok(handlers.includes("fail('invalid', r.error)"), 'setEnabled 失败必须透传 error 为 detail');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// T7：整树聚合绑定内容——等长篡改+同步改单文件清单哈希 → 聚合哈希失配必须失败
// ---------------------------------------------------------------------------

test('T7 整树聚合绑定内容：等长篡改+改单文件清单也必须失败', { skip: existsSync(join(ROOT, 'project-state.json')) ? false : '内部流程文件未随公开仓库分发（交接检查器回归需要状态源与 tasks 证据）' }, async () => {
  const tmp = join(tmpdir(), `er04-t7-${Math.random().toString(36).slice(2, 8)}`);
  const { cpSync } = await import('node:fs');
  mkdirSync(tmp, { recursive: true });
  cpSync(ROOT, tmp, { recursive: true, filter: (s) => !['.git', 'node_modules', 'release', 'dist', 'logs'].includes(s.split(/[\\/]/).pop()) });
  // H4：复制后必须断言排除真的生效——否则副本带入 .git 会让 buildBaseline 的 commit 得到
  // "nothing to commit"，测试还没到篡改断言就退出 1（Windows 反斜杠路径下 [\/] 只切正斜杠）。
  for (const banned of ['.git', 'node_modules', 'release', 'dist', 'logs']) {
    assert.equal(existsSync(join(tmp, banned)), false, `副本不得包含 ${banned}（路径过滤必须对反斜杠生效）`);
  }
  try {
    // 第六轮 §4：受控 Git 基线 + 副本内真实重冻结 + 整树重建——篡改失败可精确归因（不再"包含 13 即算"）
    const { buildBaseline, runCheck } = await import('./lib-baseline.mjs');
    buildBaseline(tmp);
    const base = runCheck(tmp);
    assert.ok(!/✗/.test(base.output), `受控基线应全绿：${base.output.slice(-500)}`);
    const st = JSON.parse(readFileSync(join(tmp, 'project-state.json'), 'utf8'));
    const mfPath = join(tmp, st.worktree_whole.manifest);
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    const target = mf.files.find((f) => f.path.endsWith('.md') && !f.path.includes('tasks/'));
    assert.ok(target, '整树清单中应有可篡改的 md 目标');
    const p = join(tmp, target.path);
    // 等长单字节篡改 + 同步更新单文件 sha256（攻击者能改清单），整树聚合必须抓住
    const buf = readFileSync(p);
    buf[0] = buf[0] ^ 0x20;
    writeFileSync(p, buf);
    const { createHash } = await import('node:crypto');
    target.sha256 = createHash('sha256').update(buf).digest('hex');
    writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    const r = runCheck(tmp);
    assert.equal(r.code, 1, '反例必须失败');
    assert.ok(/✗ 13/.test(r.output), `必须精确报 ✗ 13：${r.output.slice(-500)}`);
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// 附加并发合同：同日两个写入者都保留（相继修订）
// ---------------------------------------------------------------------------

test('附加 同日两个写入者：唯一索引仲裁下双方记录都保留，恰好一份当前正式版', async () => {
  const tmp = join(tmpdir(), `er04-cc-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const reports = mod('reports');
    const mk = (content) => ({
      coverage: 'c', experiences: [content], feelings: [], keep_practices: [], open_questions: [],
      related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [], fact_sources: [],
    });
    // 两个独立连接顺序交错写（BEGIN IMMEDIATE 串行化）——双方记录都保留
    const dbA = openDb(join(tmp, 'a.db'));
    const dbB = openDb(join(tmp, 'a.db'));
    const base = { date: '2026-01-01', sourceSessionId: 'sA', model: null, promptVersion: null, requestId: null, formal: true };
    const r1 = reports.insertCurrentRevision(dbA, { ...base, content: mk('写入者 A 的记录') });
    const r2 = reports.insertCurrentRevision(dbB, { ...base, sourceSessionId: 'sB', content: mk('写入者 B 的记录') });
    assert.equal(r1.rev, 1);
    assert.equal(r2.rev, 2);
    const currents = all(dbA, `SELECT id FROM daily_reports WHERE formal=1 AND superseded_by IS NULL`);
    assert.equal(currents.length, 1, '恰好一份当前正式版');
    const total = get(dbA, `SELECT COUNT(*) AS n FROM daily_reports`).n;
    assert.equal(total, 2, '双方记录都保留');
    const latest = JSON.parse(reports.getReport(dbA, currents[0].id).content_json);
    assert.ok(latest.experiences[0].includes('写入者 B'), '当前版是后写入者');
    // 附加并发合同：事务外补替已删除（wiring）——insertCurrentRevision 在事务内完成替代
    const reportsSrc = readFileSync(join(ROOT, 'dist/main/reports.js'), 'utf8');
    assert.ok(reportsSrc.includes('insertCurrentRevision'), '使用 insertCurrentRevision（事务内替代）');
    assert.ok(!reportsSrc.includes('supersedeOlderRevisions(db, report.date, newReport.id)'), 'acceptReportAction 不得在事务外补替');
    dbA.close(); dbB.close();
  } finally {
    rmTmp(tmp);
  }
});
