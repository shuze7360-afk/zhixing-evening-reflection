// ER-R01 第六轮修正反例（对应 Codex 第六轮审阅 G1—G5 + §4 恢复范围实证）。
// 每项：修复前失败 / 修复后通过；隔离数据库、mock 模型、真实 IPC 处理函数（electron 替身）。
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

// ---------------------------------------------------------------------------
// G1：旧版行动确认 → 明确 stale（当前内容不回退）；重复确认幂等
// ---------------------------------------------------------------------------

test('G1-a 旧修订上确认行动：明确 stale，当前汇总不回退、不产生新修订', () => {
  const tmp = join(tmpdir(), `er07-g1a-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const cand = [{ action: '今晚散步十分钟', rationale: '' }];
    const v1 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['早晨记录'], action_candidates: cand }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    const v2 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['早晨记录', '下午新增记录'], action_candidates: cand }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    // 停留在 v1 的页面确认行动（旧请求晚到）
    const r = reports.acceptReportAction(db, { reportId: v1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r.ok, false, '旧修订上的行动确认必须失败');
    assert.equal(r.error, 'stale', `明确返回 stale：${JSON.stringify(r)}`);
    const currents = all(db, `SELECT id, content_json FROM daily_reports WHERE formal=1 AND superseded_by IS NULL`);
    assert.equal(currents.length, 1);
    assert.equal(currents[0].id, v2.id, '当前版未被旧内容顶替');
    const c = JSON.parse(currents[0].content_json);
    assert.deepEqual(c.experiences, ['早晨记录', '下午新增记录'], '当前汇总不回退（下午内容保留）');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '未产生新修订');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('G1-b 重复行动确认幂等：同一行动不重复接受、不重复产生修订', async () => {
  const tmp = join(tmpdir(), `er07-g1b-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const db = openDb(join(tmp, 'a.db'));
    const v1 = reports.insertCurrentRevision(db, {
      date: '2025-01-01', sourceSessionId: 's', content: mkContent({ experiences: ['记录'], action_candidates: [{ action: '今晚散步十分钟', rationale: '' }] }),
      model: 'm', promptVersion: 'v1', requestId: null, formal: true,
    });
    const r1 = reports.acceptReportAction(db, { reportId: v1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '首次确认产生新修订');
    // 快速双击（页面未刷新）：第二次仍以旧版 v1 的 id + 下标提交同一行动
    const r2 = reports.acceptReportAction(db, { reportId: v1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(r2.ok, true, `重复确认应幂等：${JSON.stringify(r2)}`);
    assert.equal(r2.report.id, r1.report.id, '幂等返回当前版');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM daily_reports WHERE date='2025-01-01'`).n, 2, '不重复产生修订');
    const c = JSON.parse(reports.getReport(db, r1.report.id).content_json);
    assert.equal(c.actions_accepted.filter((a) => a.action === '今晚散步十分钟').length, 1, '已接受行动不重复');
    await new Promise((r) => setTimeout(r, 250)); // 等确认触发的导出微任务完成，避免关库后异步活动
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// G2：同日重新提炼不清空已接受行动（真实确认 → 真实 endSession 链路）
// ---------------------------------------------------------------------------

test('G2 真实确认后同日重新提炼：已接受行动与确认时间保留（模型结果不携带确认状态）', async () => {
  const tmp = join(tmpdir(), `er07-g2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const refine1 = JSON.stringify({
      coverage: 'c', experiences: ['我去散步了，感觉放松。'], feelings: [], keep_practices: [], open_questions: [],
      related_ideas: [], ai_notes: [], action_candidates: [{ action: '今晚散步十分钟', rationale: '' }],
    });
    const refine2 = JSON.stringify({
      coverage: 'c', experiences: ['散步后做了拉伸。'], feelings: [], keep_practices: [], open_questions: [],
      related_ideas: [], ai_notes: [], action_candidates: [],
      // 模型伪造确认状态（G2 反例强化）：也不得进入正式日报
      actions_accepted: [{ action: '伪造的已接受行动', accepted_at: '2025-01-01T00:00:00Z' }],
      feelings_confirmed: ['伪造确认'],
    });
    const seq = [
      () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(refine1),
      () => sse2(['data: {"choices":[{"delta":{"content":"ok","finish_reason":"stop"}}]}\n\n', 'data: [DONE]\n\n']),
      () => jsonResp(refine2),
    ];
    const svc = mod('session').createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0',
      cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e },
      fetchFn: async () => { const n = seq.shift(); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    // 第一次复盘 → 确认行动 → 当前日报含 1 条已接受行动
    const s1 = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: s1, content: '我去散步了，感觉放松。' });
    const e1 = await svc.endSession(s1);
    assert.equal(e1.ok, true, e1.detail);
    const v1 = svc.getToday().latestReport;
    const acc = reports.acceptReportAction(db, { reportId: v1.id, index: 0, appVersion: '0.1.0', notify: () => undefined });
    assert.equal(acc.ok, true, JSON.stringify(acc));
    const before = JSON.parse(reports.getReport(db, acc.report.id).content_json);
    assert.equal(before.actions_accepted.length, 1);
    const acceptedAt = before.actions_accepted[0].accepted_at;
    // 同日第二次复盘（重新提炼）：模型结果中 actions_accepted 为空 + 伪造字段
    const s2 = svc.startChat().snapshot.session.id;
    await svc.send({ sessionId: s2, content: '散步后做了拉伸。' });
    const e2 = await svc.endSession(s2);
    assert.equal(e2.ok, true, e2.detail);
    await new Promise((r) => setTimeout(r, 250));
    const after = JSON.parse(svc.getToday().latestReport.contentJson);
    assert.equal(after.actions_accepted.length, 1, 'G2 核心：重新提炼不清空已接受行动');
    assert.equal(after.actions_accepted[0].action, '今晚散步十分钟');
    assert.equal(after.actions_accepted[0].accepted_at, acceptedAt, '确认时间保留（最早确认）');
    assert.deepEqual(after.feelings_confirmed, [], '伪造确认字段仍被剥离');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// G3：导出排程持续失败——重试零新增模型请求、无重复正式修订、明确错误
// ---------------------------------------------------------------------------

test('G3 排程持续失败：多次重试零新增模型调用、恰一份报告；恢复后只补做导出', async () => {
  const tmp = join(tmpdir(), `er07-g3-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true });
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('d0','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['普通的一天记录'] })));
    let modelCalls = 0;
    let finalCalls = 0;
    const fetchFn = async (_url, init) => {
      modelCalls++;
      const sys = JSON.parse(init.body).messages.find((m) => m.role === 'system').content;
      if (sys.includes('最终汇总')) finalCalls++;
      return jsonResp(JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [] }));
    };
    const mkService = () => mod('periodic').createPeriodService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => 'k',
      fetchFn, notifyApp: () => undefined,
    });
    // 持续注入导出任务创建失败（BEFORE INSERT 触发器）
    run(db, `CREATE TRIGGER fail_export BEFORE INSERT ON export_tasks
             BEGIN SELECT RAISE(ABORT, '注入的排程失败'); END`);
    const r1 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r1.ok, false, '首次：报告已发布但排程失败必须明确返回');
    assert.ok((r1.detail ?? '').includes('导出排程失败'), r1.detail);
    const r2 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r2.ok, false, '重试：仍明确返回排程失败');
    assert.ok((r2.detail ?? '').includes('导出排程失败'), r2.detail);
    // G3 核心断言（对齐审阅期望）：最多 2 次模型调用（1 批次 + 1 最终汇总）、恰 1 份正式报告
    assert.equal(modelCalls, 2, `模型调用必须恰好 2 次（实测 ${modelCalls}）`);
    assert.equal(finalCalls, 1, `最终汇总不得重复（实测 ${finalCalls}）`);
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '无重复正式修订');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM model_requests WHERE status='verified'`).n, 2, 'verified 请求 2 条');
    // 解除故障 → 重试只补做导出（零模型调用、同一份报告）
    run(db, `DROP TRIGGER fail_export`);
    const r3 = await mkService().generate({ kind: 'weekly', start: '2025-01-01', end: '2025-01-01', label: 'W' });
    assert.equal(r3.ok, true, r3.detail);
    assert.equal(modelCalls, 2, '补做导出零模型调用');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM period_reports`).n, 1, '仍恰一份报告');
    assert.ok(existsSync(join(tmp, 'vault', '周报', '2025-01-01_2025-01-01.md')), '导出文件已生成');
    await new Promise((res) => setTimeout(res, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// G4：周期报告导出状态与解决入口（真实迁移产生 UNRESOLVED 周期任务 → 列表可见 → 选择目录 → 重启保持）
// ---------------------------------------------------------------------------

test('G4 周期报告导出链路：列表返回任务、UNRESOLVED 可见可解、绑定跨重启保持', async () => {
  const tmp = join(tmpdir(), `er07-g4-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 模拟上一版 v3 库：周期报告 + NULL 目标导出任务
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    const content = JSON.stringify({
      coverage: 'c', highlights: ['h'], patterns: [], open_questions: [],
      bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 },
    });
    run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
             VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`, content);
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, last_error, created_at, updated_at)
             VALUES ('pt1','period_report','p1','周报/2024-12-30_2025-01-05.md','h',NULL,'failed',1,'目标未定','t','t')`);
    pre.close();
    const db = openDb(dbPath); // 真实迁移 v3→v4
    assert.equal(get(db, `SELECT vault_dir FROM export_tasks WHERE id='pt1'`).vault_dir, 'UNRESOLVED');
    // G4 核心：周期报告列表必须返回导出任务（此前不返回，用户无入口）
    const list = mod('periodic').listPeriodReports(db);
    const row = list.find((x) => x.id === 'p1');
    assert.ok(row, '周期报告在列表中');
    assert.ok(row.exportTask, 'G4 核心：periodList 返回 exportTask');
    assert.equal(row.exportTask.status, 'failed');
    assert.ok((row.exportTask.lastError ?? '').includes('目标未定'));
    // 重试明确报错（不悄悄换目录）
    const r1 = await mod('obsidian').runExportTask(db, 'pt1', '0.1.0');
    assert.equal(r1.ok, false);
    assert.ok((r1.error ?? '').includes('目标未定'), r1.error);
    // 选择目录 → 绑定 → 零模型导出成功
    const vaultB = join(tmp, 'vaultB');
    mkdirSync(vaultB, { recursive: true });
    const r2 = await mod('obsidian').bindTaskTargetAndExport(db, 'pt1', vaultB, '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.status, 'done');
    assert.ok(existsSync(join(vaultB, '周报', '2024-12-30_2025-01-05.md')), '周期报告写入用户选择目录');
    // 列表反映 done；重启（重开连接）后绑定保持
    const after = mod('periodic').listPeriodReports(db).find((x) => x.id === 'p1');
    assert.equal(after.exportTask.status, 'done');
    db.close();
    const db2 = openDb(dbPath);
    assert.equal(get(db2, `SELECT vault_dir FROM export_tasks WHERE id='pt1'`).vault_dir, vaultB, '绑定跨重启保持');
    const r3 = await mod('obsidian').retryExportTask(db2, 'pt1', '0.1.0');
    assert.equal(r3.ok, true, '重启后重试仍用绑定目录');
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// G5：openLocation 必须用任务绑定目录与实际发布路径（真实 IPC 处理函数 + shell 替身）
// ---------------------------------------------------------------------------

test('G5 openLocation：全局 A / 任务 B → 定位 B；全局未配置 → 定位 B；A 有同名文件不误指', async () => {
  const tmp = join(tmpdir(), `er07-g5-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // electron 替身（真实 ipc-handlers 注册路径）
    const electronPath = require.resolve('electron');
    const shellCalls = [];
    const handlers = new Map();
    require.cache[electronPath] = {
      id: electronPath, filename: electronPath, loaded: true, children: [],
      exports: {
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        shell: { showItemInFolder: (p) => shellCalls.push(p), openPath: () => '' },
      },
    };
    const { registerIpcHandlers } = require(join(ROOT, 'dist/main/ipc-handlers.js'));

    const makeWorld = (withGlobal) => {
      const world = join(tmp, Math.random().toString(36).slice(2, 8));
      mkdirSync(join(world, 'A', '日报'), { recursive: true });
      mkdirSync(join(world, 'B', '日报'), { recursive: true });
      const db = openDb(join(world, 'zhixing.db'));
      if (withGlobal) settingsMod.setPlainSettings(db, { obsidianDir: join(world, 'A') });
      run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
        JSON.stringify(mkContent({ experiences: ['记录'] })));
      return { world, db, taskRel: '日报/2025-01-01.md' };
    };
    const depsOf = (db) => ({
      db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: tmp,
      session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => sse2([]), notifyModel: () => undefined, notifyApp: () => undefined }),
      period: mod('periodic').createPeriodService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => null, notifyApp: () => undefined }),
      fetchFn: async () => sse2([]),
    });
    const openLoc = async (db, taskId) => handlers.get('export:openLocation')({}, { taskId });

    // 场景 1：全局 A / 任务 B → 定位 B 的真实文件
    {
      const { world, db, taskRel } = makeWorld(true);
      registerIpcHandlers(depsOf(db)); // 真实注册全部 IPC 处理函数（electron 已替换）
      const vaultB = join(world, 'B');
      const t = mod('obsidian');
      writeFileSync(join(world, 'A', taskRel), 'A 里的同名文件', 'utf8'); // A 有同名文件（不得误指）
      writeFileSync(join(vaultB, taskRel), 'B 里真实发布的文件', 'utf8');
      const taskId = await new Promise((res) => {
        const id = require('node:crypto').randomUUID();
        // L2：done 任务的 content_hash 必须与记录路径上的实际文件一致（否则一致性守卫会正确拒绝）
        run(db, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
                 VALUES (?, 'daily_report', 'r1', ?, ?, ?, 'done', 1, 't', 't')`,
          id, taskRel, t.sha256Hex(Buffer.from('B 里真实发布的文件', 'utf8')), vaultB);
        res(id);
      });
      shellCalls.length = 0;
      const r = await openLoc(db, taskId);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(shellCalls.length, 1, 'shell 被调用');
      assert.ok(shellCalls[0].startsWith(vaultB), `G5 核心：定位到任务绑定目录 B（实际 ${shellCalls[0]}）`);
      assert.ok(!shellCalls[0].startsWith(join(world, 'A')), '不得误指全局 A 的同名文件');
      db.close();
    }
    // 场景 2：全局未配置 + 任务绑定 B → 仍定位 B
    {
      const { world, db, taskRel } = makeWorld(false);
      registerIpcHandlers(depsOf(db));
      const vaultB = join(world, 'B');
      const fileContent = 'B 文件';
      writeFileSync(join(vaultB, taskRel), fileContent, 'utf8');
      const id = require('node:crypto').randomUUID();
      run(db, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
               VALUES (?, 'daily_report', 'r1', ?, ?, ?, 'done', 1, 't', 't')`,
        id, taskRel, mod('obsidian').sha256Hex(Buffer.from(fileContent, 'utf8')), vaultB);
      shellCalls.length = 0;
      const r = await openLoc(db, id);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(shellCalls[0].startsWith(vaultB), '全局未配置时用绑定目录');
      db.close();
    }
    // 场景 3：全局与任务都未配置 → 明确报错（不抛异常）
    {
      const { db } = makeWorld(false);
      registerIpcHandlers(depsOf(db));
      const id = require('node:crypto').randomUUID();
      run(db, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
               VALUES (?, 'daily_report','r1','日报/x.md','h',NULL,'done',1,'t','t')`, id);
      const r = await openLoc(db, id);
      assert.equal(r.ok, false);
      assert.ok((r.detail ?? '').includes('未配置'), r.detail);
      db.close();
    }
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// §4 恢复范围实证：持有真实连接时恢复**明确失败**（不静默替换）；关闭连接后恢复成功。
// 同时修正表述：gate+写入拒绝覆盖应用协议内的写入；SQL 检查与 gate 之间非原子，
// "全程排他"仅指本协议范围（第六轮审阅 §4）。
// ---------------------------------------------------------------------------

test('§4 持有真实连接恢复：EBUSY 类明确失败、原库完整；关闭连接后恢复成功', () => {
  const tmp = join(tmpdir(), `er07-restore-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const userData = join(tmp, 'userdata');
    const dbPath = join(userData, 'zhixing.db');
    const backup = mod('backup');
    const db = openDb(dbPath);
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('before-backup', '1', 't')`);
    const outDir = join(tmp, 'backups');
    mkdirSync(outDir, { recursive: true });
    const b = backup.backupDatabase(db, outDir, userData);
    assert.equal(b.ok, true, b.error);
    // 备份之后写入的数据（只存在于当前库，恢复后应消失并进入 before-restore 存档）
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('hold-probe', '1', 't')`);
    const req = backup.requestRestore(userData, b.file);
    assert.equal(req.ok, true, req.error);
    // 持有真实连接（不关闭）→ 恢复必须明确失败，原库不被静默替换
    const applied1 = backup.applyPendingRestore(userData);
    assert.equal(applied1.restored, false, '持有连接时恢复不得成功');
    assert.equal(applied1.failed, true, '必须明确失败');
    assert.ok(applied1.error, applied1.error);
    // 原库完整：探针数据仍可通过持有连接读到
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM settings WHERE key='hold-probe'`).n, 1, '原库数据未被破坏');
    assert.equal(existsSync(dbPath), true, '当前库仍在');
    // 关闭连接 → 恢复成功
    db.close();
    const applied2 = backup.applyPendingRestore(userData);
    assert.equal(applied2.restored, true, `关闭连接后恢复应成功：${applied2.error}`);
    assert.ok(existsSync(join(userData, 'zhixing.db.before-restore')), '原库留档');
    const db2 = openDb(dbPath);
    assert.equal(get(db2, `SELECT COUNT(*) AS n FROM settings WHERE key='hold-probe'`).n, 0, '恢复后回到备份内容');
    assert.equal(get(db2, `SELECT COUNT(*) AS n FROM settings WHERE key='before-backup'`).n, 1, '备份数据生效');
    db2.close();
  } finally {
    rmTmp(tmp);
  }
});
