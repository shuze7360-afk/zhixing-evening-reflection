// ER-R01 第七轮修正反例（对应 Codex 第七轮审阅 H1—H3；H4 = T7 过滤器修复，见 err04）。
// 每项：修复前失败 / 修复后通过；隔离数据库、mock 模型、真实 IPC 处理函数（electron 替身）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const mod = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const { openDb, get, all, run } = require(join(ROOT, 'dist/main/db.js'));
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
const reports = mod('reports');

// electron 替身：模块顶层注入一次（ipc-handlers 模块只加载一次，其 ipcMain 绑定到本表）。
// 各测试共用 handlers 表，按需重新 registerIpcHandlers（后注册覆盖同通道）。
const shellCalls = [];
const handlers = new Map();
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true, children: [],
  exports: {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: (p) => shellCalls.push(p), openPath: () => '' },
  },
};

// ---------------------------------------------------------------------------
// H1：跨午夜收束——可信历史按**目标报告日期**（session.date）读取，不从墙钟推导。
// 反例构造：会话与已确认行动都归属过去日期 D（模拟"23:58 开始、00:02 收束"——
// 收束时墙钟已不是 D，修复前 prevTrusted() 读墙钟日期 → 已接受行动丢失）。
// 同时验证不串日：当天（真实今天）自己的确认记录不得混入 D 的报告。
// ---------------------------------------------------------------------------

test('H1 跨午夜/旧会话重试：按 session.date 读取可信历史，不丢失、不串日', async () => {
  const tmp = join(tmpdir(), `er08-h1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const D = '2025-01-01'; // 过去日期（模拟午夜前开始的那天）
    // D 的正式日报 v1：一条经历 + 行动候选
    const v1 = reports.insertCurrentRevision(db, {
      date: D, sourceSessionId: 's0', content: mkContent({ experiences: ['我去散步了。'], action_candidates: [{ action: '今晚散步十分钟', rationale: '' }] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    // 真实确认链路：D 的报告接受行动 → v2（当前）含 1 条已接受行动
    const acc = reports.acceptReportAction(db, { reportId: v1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(acc.ok, true, JSON.stringify(acc));
    const acceptedAt = JSON.parse(reports.getReport(db, acc.report.id).content_json).actions_accepted[0].accepted_at;
    // "新一天"（真实今天）自己的确认记录——不得串入 D 的报告
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const t1 = reports.insertCurrentRevision(db, {
      date: todayIso, sourceSessionId: 's1', content: mkContent({ experiences: ['今天的事'], action_candidates: [{ action: '今天才有的行动', rationale: '' }] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    const accToday = reports.acceptReportAction(db, { reportId: t1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(accToday.ok, true);
    // 旧会话（归属 D，跨午夜后才收束/重试提炼）：手工构造会话行 + 用户消息（真实 endSession 链路）
    const sid = randomUUID();
    run(db, `INSERT INTO sessions (id, date, kind, phase, followup_used, status, prompt_version, model, started_at)
             VALUES (?, ?, 'chat', 'narrate', 0, 'active', 'v1', 'm', '2025-01-01T23:58:00')`, sid, D);
    run(db, `INSERT INTO messages (id, session_id, role, kind, content, state, created_at)
             VALUES (?, ?, 'user', 'text', ?, 'verified', '2025-01-01T23:58:30')`, randomUUID(), sid, '我去散步了。');
    const seq = [
      () => jsonResp(JSON.stringify({
        coverage: 'c', experiences: ['我去散步了。'], feelings: [], keep_practices: [], open_questions: [],
        related_ideas: [], ai_notes: [], action_candidates: [],
        actions_accepted: [{ action: '伪造的已接受行动', accepted_at: '2025-01-02T00:02:00Z' }], // 模型伪造：必须剥离
      })),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0',
      cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e },
      fetchFn: async () => { const n = seq.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const end = await svc.endSession(sid);
    assert.equal(end.ok, true, JSON.stringify(end));
    await new Promise((r) => setTimeout(r, 250));
    // D 的新当前版：已接受行动保留（不因跨午夜丢失），确认时间不变，不串入今天的行动
    const current = get(db, `SELECT content_json FROM daily_reports WHERE date = ? AND formal = 1 AND superseded_by IS NULL`, D);
    const c = JSON.parse(current.content_json);
    assert.equal(c.actions_accepted.length, 1, `H1 核心：跨午夜收束不得清空已接受行动（实测 ${JSON.stringify(c.actions_accepted)}）`);
    assert.equal(c.actions_accepted[0].action, '今晚散步十分钟');
    assert.equal(c.actions_accepted[0].accepted_at, acceptedAt, '确认时间保留');
    assert.ok(!JSON.stringify(c.actions_accepted).includes('今天才有的行动'), '不得串入其他日期的确认记录');
    assert.ok(!JSON.stringify(c.actions_accepted).includes('伪造的已接受行动'), '模型伪造仍被剥离');
    assert.deepEqual(c.feelings_confirmed, []);
    // 今天的报告不受影响
    const todayReport = get(db, `SELECT content_json FROM daily_reports WHERE date = ? AND formal = 1 AND superseded_by IS NULL`, todayIso);
    const ct = JSON.parse(todayReport.content_json);
    assert.equal(ct.actions_accepted[0]?.action, '今天才有的行动', '今天的确认记录不受波及');
    await new Promise((r) => setTimeout(r, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// H2：报告已发布但导出任务创建失败——真实用户入口（reports:periodExportRetry）补排程，
// 零模型调用；重启扫掠不重复。electron 替身 + 真实 ipc-handlers。
// ---------------------------------------------------------------------------

test('H2 报告已发布无任务：用户入口补排程成功、零新增模型请求、重启不重复', async () => {
  const tmp = join(tmpdir(), `er08-h2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const { registerIpcHandlers } = require(join(ROOT, 'dist/main/ipc-handlers.js'));

    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('d0','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['普通的一天记录'] })));
    let modelCalls = 0;
    const mkService = () => mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn: async (_url, init) => {
        modelCalls++;
        return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
      },
      notifyApp: () => undefined,
    });
    // 注入排程失败（一次持续故障）：报告发布、任务缺失
    run(db, `CREATE TRIGGER fail_export BEFORE INSERT ON export_tasks
             BEGIN SELECT RAISE(ABORT, '注入的排程失败'); END`);
    const r1 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r1.ok, false);
    assert.ok((r1.detail ?? '').includes('导出排程失败'), r1.detail);
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '报告已发布');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM export_tasks`).n, 0, '任务缺失（缺口状态）');
    const modelCallsAfterFailure = modelCalls;
    const listBefore = mod('periodic').listPeriodReports(db)[0];
    assert.equal(listBefore.exportTask, null, '列表可见：该报告没有导出任务（页面据此显示补做入口）');
    // 解除故障 → 走真实用户入口补排程
    run(db, `DROP TRIGGER fail_export`);
    registerIpcHandlers({
      db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: tmp,
      session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => sse2([]), notifyModel: () => undefined, notifyApp: () => undefined }),
      period: mkService(),
      fetchFn: async () => sse2([]),
    });
    const r2 = await handlers.get('reports:periodExportRetry')({}, { reportId: listBefore.id });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.status, 'done');
    assert.ok(existsSync(join(tmp, 'vault', '周报', '2025-01-01_2025-01-01.md')), '补做导出成功');
    assert.equal(modelCalls, modelCallsAfterFailure, 'H2 核心：补排程零新增模型请求');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '仍恰一份报告');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM model_requests WHERE status='verified'`).n, 2, '模型请求仍 2 条 verified');
    // 重启（重开连接 + 启动扫掠）：不重复建任务、不重复发布、不再调用模型
    db.close();
    const db2 = openDb(join(tmp, 'a.db'));
    await mod('obsidian').recoverPendingExports(db2, '0.1.0'); // J2：async 合同——逐任务等待
    assert.equal(get(db2, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '重启后仍一份报告');
    assert.equal(get(db2, `SELECT COUNT(*) AS n FROM export_tasks WHERE ref_id=(SELECT id FROM period_reports LIMIT 1)`).n, 1, '不重复建任务');
    assert.equal(modelCalls, modelCallsAfterFailure, '重启扫掠零模型调用');
    await new Promise((r) => setTimeout(r, 250)); // 清空可能排队的微任务，避免关库后异步活动
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// H3：done/UNRESOLVED 历史任务——openLocation 不得静默回退全局目录（同名无关文件）；
// targetUnresolved 透传视图；绑定后重新核验导出（不假报完成）；取消零写入；重启保持。
// ---------------------------------------------------------------------------

test('H3 done/UNRESOLVED：openLocation 拒绝回退、绑定后重验证、取消零写入、重启保持', async () => {
  const tmp = join(tmpdir(), `er08-h3-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const { registerIpcHandlers } = require(join(ROOT, 'dist/main/ipc-handlers.js'));

    const dbPath = join(tmp, 'zhixing.db');
    // 模拟上一版 v3 库：日报 + done/NULL 周期任务（真实迁移 → done/UNRESOLVED）
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    const content = JSON.stringify({
      coverage: 'c', highlights: ['h'], patterns: [], open_questions: [],
      bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 },
    });
    run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
             VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`, content);
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
             VALUES ('pt1','period_report','p1','周报/2024-12-30_2025-01-05.md','h',NULL,'done',1,'t','t','t')`);
    pre.close();
    const db = openDb(dbPath); // 真实迁移
    const t = get(db, `SELECT vault_dir, status FROM export_tasks WHERE id='pt1'`);
    assert.equal(t.vault_dir, 'UNRESOLVED');
    assert.equal(t.status, 'done', 'done 状态保留（迁移不改状态）');
    // 视图透传：targetUnresolved 可见（页面据此显示确认入口而非"显示位置"）
    const row = mod('periodic').listPeriodReports(db).find((x) => x.id === 'p1');
    assert.equal(row.exportTask.targetUnresolved, true, 'H3 核心：targetUnresolved 透传视图');
    // 全局目录 A 放入同相对路径的无关文件 → openLocation 必须拒绝，不得打开 A 的同名文件
    mkdirSync(join(tmp, 'A', '周报'), { recursive: true });
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'A') });
    writeFileSync(join(tmp, 'A', '周报', '2024-12-30_2025-01-05.md'), '全局目录里的同名无关文件', 'utf8');
    registerIpcHandlers({
      db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: tmp,
      session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => sse2([]), notifyModel: () => undefined, notifyApp: () => undefined }),
      period: mod('periodic').createPeriodService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => null, notifyApp: () => undefined }),
      fetchFn: async () => sse2([]),
    });
    shellCalls.length = 0;
    const loc1 = await handlers.get('export:openLocation')({}, { taskId: 'pt1' });
    assert.equal(loc1.ok, false, 'UNRESOLVED 不得静默回退全局目录');
    assert.equal(shellCalls.length, 0, '不得打开任何文件');
    assert.ok(/目标未确认|选择目标/.test(loc1.detail ?? ''), loc1.detail);
    // 取消：零写入
    const obsidian = mod('obsidian');
    const canceled = await obsidian.bindTaskTargetAndExport(db, 'pt1', null, '0.1.0');
    assert.ok(canceled.canceled === true);
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='pt1'`).vault_dir, 'UNRESOLVED', '取消后不变');
    // 选择目标 B：绑定 + 重新核验导出（不因旧 done 假报完成）
    const vaultB = join(tmp, 'B', '周报');
    mkdirSync(vaultB, { recursive: true });
    const bound = await obsidian.bindTaskTargetAndExport(db, 'pt1', join(tmp, 'B'), '0.1.0');
    assert.equal(bound.ok, true, bound.error);
    assert.equal(bound.status, 'done', '重新核验后完成');
    assert.ok(existsSync(join(vaultB, '2024-12-30_2025-01-05.md')), '文件真实发布到用户选择目录');
    // 绑定后 openLocation 定位 B（shell 替身）
    shellCalls.length = 0;
    const loc2 = await handlers.get('export:openLocation')({}, { taskId: 'pt1' });
    assert.equal(loc2.ok, true, JSON.stringify(loc2));
    assert.equal(shellCalls.length, 1);
    assert.ok(shellCalls[0].startsWith(join(tmp, 'B')), `定位到绑定目录 B（实际 ${shellCalls[0]}）`);
    // 重启保持
    db.close();
    const db2 = openDb(dbPath);
    assert.equal(get(db2, `SELECT vault_dir FROM export_tasks WHERE id='pt1'`).vault_dir, join(tmp, 'B'), '绑定跨重启保持');
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});
