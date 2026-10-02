// ER-R01 第二轮修正反例测试（对应独立复核 6 阻塞 + 关键非阻塞）。
// 修复前失败 / 修复后通过；隔离数据库、mock fetch、临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
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
const VALID_REFINE = JSON.stringify({
  coverage: 'c', experiences: [], feelings: [], keep_practices: [], open_questions: [],
  related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [],
});

// ---------------------------------------------------------------------------
// B1：恢复失败 → 启动决策 abort（不得静默空库）
// ---------------------------------------------------------------------------

test('B1 evaluateStartupRestore：恢复失败+无当前库 → abort；失败+有当前库 → continue 带错误', () => {
  const tmp = join(tmpdir(), `er03-b1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const backup = mod('backup');
    // 场景 1：恢复失败（源是目录）+ 当前库不存在 → abort
    const bad = join(tmp, 'badsrc');
    mkdirSync(bad, { recursive: true });
    run; void run;
    const { openDb: _o } = { openDb };
    const marker = join(tmp, 'pending-restore.json');
    const fsMod = { w: (p, v) => require('node:fs').writeFileSync(p, v) };
    fsMod.w(marker, JSON.stringify({ from: bad }));
    const d1 = backup.evaluateStartupRestore(tmp);
    assert.equal(d1.action, 'abort', `实测 ${JSON.stringify(d1)}`);
    assert.ok(d1.error);
    assert.equal(existsSync(join(tmp, 'zhixing.db')), false, '不得静默创建库');
    // W1：失败且无库 → gate 保留，openDb 明确拒绝建库（持久阻止空库，直到明确解决）
    const dbPath = join(tmp, 'zhixing.db');
    assert.throws(() => openDb(dbPath), /恢复/, 'gate 必须阻止建库');
    require('node:fs').unlinkSync(dbPath + '.restore-gate'); // 明确解决（删除 gate）后才能建库
    // 场景 2：恢复失败 + 当前库存在（已回滚）→ continue + 错误（启动可继续但必须告知）
    const db = openDb(dbPath);
    db.close();
    fsMod.w(marker, JSON.stringify({ from: bad }));
    const d2 = backup.evaluateStartupRestore(tmp);
    assert.equal(d2.action, 'continue');
    assert.ok(d2.error, '必须携带错误供界面呈现');
    assert.equal(existsSync(dbPath), true, '原库保留');
    // 场景 3：合法恢复 → continue + from
    const db2 = openDb(dbPath);
    const out = join(tmp, 'bk');
    mkdirSync(out, { recursive: true });
    const r = backup.backupDatabase(db2, out, tmp);
    assert.equal(r.ok, true, r.error);
    db2.close();
    fsMod.w(marker, JSON.stringify({ from: r.file }));
    const d3 = backup.evaluateStartupRestore(tmp);
    assert.equal(d3.action, 'continue');
    assert.equal(d3.from, r.file);
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// B2：启动恢复接线（wiring 回归——防止再次"函数存在但没调用"）
// ---------------------------------------------------------------------------

test('B2 recoverInterrupted/evaluateStartupRestore 已接入 dist 主入口', () => {
  const idx = readFileSync(join(ROOT, 'dist/main/index.js'), 'utf8');
  assert.ok(idx.includes('recoverInterrupted'), 'dist 主入口必须调用 recoverInterrupted');
  assert.ok(idx.includes('evaluateStartupRestore'), 'dist 主入口必须调用 evaluateStartupRestore');
});

// ---------------------------------------------------------------------------
// B3：预算统一入口——真实路径（send/endSession）超预算零调用 + 分价
// ---------------------------------------------------------------------------

test('B3-a 会话 refine 超预算（分价后 hold 超限）→ budget_paused 且零网络调用', async () => {
  const tmp = join(tmpdir(), `er03-b3a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 0.1, priceInCnyPerMtok: 1, priceOutCnyPerMtok: 100 });
    let calls = 0;
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { calls++; return jsonResp(VALID_REFINE); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    // 输入很小（检查价若仍按输入单价：hold≈0.001 会放行）；输出 8192×100 元/M = 0.82 → 必须拒绝
    await svc.send({ sessionId: sid, content: '短内容。' });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, false);
    assert.equal(calls, 0, `超预算时不得发起网络调用（实测 ${calls} 次）`);
    const snap = svc.getToday();
    assert.equal(snap.session.phase, 'refine_failed', '转为可重试状态');
    assert.equal(snap.latestReport, null, '不虚报正式日报');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('B3-b chat 路径同样经 reserve：超预算零调用', async () => {
  const tmp = join(tmpdir(), `er03-b3b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { budgetMonthlyCny: 0.001, priceInCnyPerMtok: 1, priceOutCnyPerMtok: 100 });
    let calls = 0;
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { calls++; return sse(['data: {"choices":[{"delta":{"content":"x","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    const r = await svc.send({ sessionId: sid, content: '超预算发送。' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'budget_paused');
    assert.equal(calls, 0, 'chat 超预算零调用');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// B4：周期报告真分批——365 份日报 → 多次请求，每次 <24KiB，证据索引完整
// ---------------------------------------------------------------------------

test('B4 周期报告 map-reduce：多请求、单请求 <24KiB、bindings 365', async () => {
  const tmp = join(tmpdir(), `er03-b4-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const ins = db.prepare(
      `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
       VALUES (?, ?, 1, 's', ?, 'm', 'v1', 1, '2025-01-01')`,
    );
    const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < 365; i++) {
      const date = localDate(new Date(2025, 0, 1 + i));
      ins.run('d' + i, date, JSON.stringify({
        coverage: 'c',
        experiences: [`第 ${i + 1} 天：记录一条不算太短的当天经历内容，确保总体积超过单次上限。`],
        feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [],
      }));
    }
    const bodies = [];
    const period = mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        bodies.push(Buffer.from(init.body, 'utf8').length);
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    const r = await period.generate({ kind: 'yearly', start: '2025-01-01', end: '2025-12-31', label: '年报 2025' });
    assert.equal(r.ok, true, r.ok ? '' : r.detail);
    assert.ok(bodies.length >= 2, `分批应产生多次请求（实测 ${bodies.length}）`);
    for (const [i, b] of bodies.entries()) {
      assert.ok(b < 24 * 1024, `第 ${i + 1} 次请求 ${b} 字节超限`);
    }
    assert.equal(r.report.bindings.daily_report_ids.length, 365, '证据索引仍绑定全部日报');
    const usage = all(db, `SELECT status FROM usage`);
    assert.ok(usage.length >= bodies.length && usage.every((u) => u.status === 'settled'), '全部批次结算');
    await new Promise((r) => setTimeout(r, 300)); // 等导出微任务完成，避免跨测试活动
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// B5：MCP 草稿 → 应用启动（startExperimentDraft 生命周期）
// ---------------------------------------------------------------------------

test('B5 草稿启动生命周期：planned → running（唯一约束）；running 不可再启动；UI 通道已登记', () => {
  const tmp = join(tmpdir(), `er03-b5-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const exp = mod('experiments');
    const args = { hypotheses: ['A', 'B', 'C'], keyIndex: 0, action: 'x', periodDays: 3, firstStep: 'y' };
    const draft = exp.createExperimentDraft(db, args, { origin: 'mcp' });
    assert.equal(draft.ok, true);
    assert.equal(draft.experiment.status, 'planned');
    // UI 通道已登记（wiring）
    const ipcSrc = readFileSync(join(ROOT, 'dist/shared/ipc.js'), 'utf8');
    assert.ok(ipcSrc.includes('experiments:start'), 'IPC 白名单必须包含 experiments:start');
    // 启动 → running
    const st = exp.startExperimentDraft(db, draft.experiment.id);
    assert.equal(st.ok, true, st.detail);
    assert.equal(st.experiment.status, 'running');
    // 已 running 的不可再启动
    const st2 = exp.startExperimentDraft(db, draft.experiment.id);
    assert.equal(st2.ok, false);
    // 第二个草稿可以存在，但其启动被单进行中拒绝
    const draft2 = exp.createExperimentDraft(db, args);
    assert.equal(draft2.ok, true);
    const st3 = exp.startExperimentDraft(db, draft2.experiment.id);
    assert.equal(st3.ok, false);
    assert.equal(st3.error, 'active_exists');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// B6：提炼提示词携带原则卡集合（上下文-提示词-schema 三方一致）
// ---------------------------------------------------------------------------

test('B6 提炼请求的 system 含已启用原则卡 ID；未启用则明示为空', async () => {
  const tmp = join(tmpdir(), `er03-b6-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const { seedPrinciples, listPrinciples, setCardEnabled } = mod('principles');
    seedPrinciples(db, join(ROOT, 'resources'));
    const card = listPrinciples(db).find((c) => c.quoteOriginal.includes('say no to everything'));
    const bodies = [];
    const mk = () => sse(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']);
    const responses = [mk, () => jsonResp(VALID_REFINE)];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async (_url, init) => { bodies.push(init.body); const n = responses.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '今天推掉了一个会议。' });
    // 未启用：提炼 system 明示空列表
    await svc.endSession(sid);
    const refineBody1 = JSON.parse(bodies[1]).messages.find((m) => m.role === 'system').content;
    assert.ok(refineBody1.includes('必须为空数组'), '未启用时提炼提示词必须明示空列表');
    // 启用：新会话再走一轮，提炼 system 含卡 ID
    setCardEnabled(db, card.id, true);
    const sid2 = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid2, content: '又推掉了一个。' });
    await svc.endSession(sid2);
    const refineBody2 = JSON.parse(bodies[3]).messages.find((m) => m.role === 'system').content;
    assert.ok(refineBody2.includes(card.id), '提炼提示词必须携带已启用原则卡 ID（实际：' + refineBody2.slice(refineBody2.indexOf('可用原则卡'), refineBody2.indexOf('可用原则卡') + 160) + '）');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// N9：检查器 09/13 强化（隔离副本）
// ---------------------------------------------------------------------------

test('N9 检查器：review.md 写"不通过"必须失败；整树漂移必须失败', { skip: existsSync(join(ROOT, 'project-state.json')) ? false : '内部流程文件未随公开仓库分发（交接检查器回归需要状态源与 tasks 证据）' }, async () => {
  const tmp = join(tmpdir(), `er03-n9-${Math.random().toString(36).slice(2, 8)}`);
  const { execFileSync } = await import('node:child_process');
  // 用当前仓库副本（含未提交修改也可以——检查器会报候选漂移，但我们要的是 09/13 的独立信号）
  const dst = join(tmp, 'repo');
  mkdirSync(dst, { recursive: true });
  const { cpSync } = await import('node:fs');
  // 只排除 .git 目录本身，不能误伤 .gitignore（否则受控基线缺核心文件）
  cpSync(ROOT, dst, { recursive: true, filter: (s) => !['.git', 'node_modules', 'release', 'dist', 'logs'].includes(s.split(/[\\/]/).pop()) });
  try {
    // 第六轮 §4：受控 Git 基线（全新提交 + 副本内真实重冻结 + 整树重建）——反例失败可精确归因
    const { buildBaseline } = await import('./lib-baseline.mjs');
    buildBaseline(dst);
    // 09：把某已审阅任务 review.md 首行改为 不通过
    const rm = join(dst, 'tasks/ER-000/review.md');
    const orig = readFileSync(rm, 'utf8');
    writeFileSync2(rm, orig.replace(/通过/g, '不通过'));
    const r1 = runCheck(dst);
    assert.ok(/✗ 09/.test(r1.output), `应精确报 ✗ 09：${r1.output.slice(-500)}`);
    assert.equal(r1.code, 1);
    // 恢复后基线全绿（受控基线上不应有任何 ✗）
    writeFileSync2(rm, orig);
    const r2 = runCheck(dst);
    assert.ok(!/✗ 09/.test(r2.output), '恢复后 09 不应失败');
    assert.ok(!/✗/.test(r2.output), `受控基线上恢复后应全绿：${r2.output.slice(-600)}`);
    // 13：篡改整树清单内某文件内容 → 精确 ✗ 13（受控基线保证清单存在且其余全绿）
    const st = JSON.parse(readFileSync(join(dst, 'project-state.json'), 'utf8'));
    const target13 = JSON.parse(readFileSync(join(dst, st.worktree_whole.manifest), 'utf8')).files.find((f) => f.path.endsWith('.md'));
    const p13 = join(dst, target13.path);
    writeFileSync2(p13, readFileSync(p13, 'utf8') + '\n<!-- drift -->\n');
    const r3 = runCheck(dst);
    assert.ok(/✗ 13/.test(r3.output), `整树漂移应精确报 ✗ 13：${r3.output.slice(-500)}`);
  } finally {
    rmTmp(tmp);
  }

  function writeFileSync2(p, v) { require('node:fs').writeFileSync(p, v); }
  function runCheck(dir) {
    try {
      const out = execFileSync(process.execPath, [join(dir, 'scripts/handoff-check.mjs')], { encoding: 'utf8', cwd: dir });
      return { code: 0, output: out };
    } catch (e) {
      return { code: e.status, output: e.stdout ?? String(e) };
    }
  }
});

// ---------------------------------------------------------------------------
// N11：证据校验头+尾（真前缀+虚构后缀 → 降级）
// ---------------------------------------------------------------------------

test('N11 证据校验：真前缀+虚构后缀的经历不得正式化', async () => {
  const tmp = join(tmpdir(), `er03-n11-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const responses = [
      () => sse(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(JSON.stringify({
        coverage: 'c',
        experiences: ['今天修好了耳机，还顺便完成了年度述职报告并拿到了公司特别嘉奖'],
        feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [],
      })),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { const n = responses.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '今天修好了耳机，很有成就感。' });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, true);
    await new Promise((r) => setTimeout(r, 120));
    const content = JSON.parse(svc.getToday().latestReport.contentJson);
    assert.deepEqual(content.experiences, [], '真前缀+虚构后缀不得正式化');
    assert.ok(content.ai_notes.join('|').includes('述职报告'), '降级为待核对');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// N12：单行多问只展示第一问
// ---------------------------------------------------------------------------

test('N12 一行内多问只保留第一问', async () => {
  const tmp = join(tmpdir(), `er03-n12-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const responses = [
      () => sse(['data: {"choices":[{"delta":{"content":"反馈"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"\\n【追问】耳机怎么坏的？顺便问下今天几点起床的？"}}]}\n\n', 'data: [DONE]\n\n']),
    ];
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR,
      fetchFn: async () => { const n = responses.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const sid = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: sid, content: '今天修好了耳机。' });
    const last = svc.getToday().messages.at(-1);
    assert.ok(last.content.includes('耳机怎么坏的？'), '第一问保留');
    assert.ok(!last.content.includes('几点起床'), '第二问不得展示');
    assert.ok(last.content.includes('每次只问一个'), '省略注明');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});
