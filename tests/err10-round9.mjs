// ER-R01 第九轮修正反例（对应 Codex 第九轮审阅 K1/K2）。
// 每项：修复前失败 / 修复后通过；隔离数据库、真实 IPC 处理函数（electron 替身）、故障注入。
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
const obsidian = mod('obsidian');

function rmTmp(dir) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); }
  }
}
function mkContent(over = {}) {
  return {
    coverage: 'c', experiences: [], feelings: [], keep_practices: [], open_questions: [],
    related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [], fact_sources: [],
    ...over,
  };
}

// electron 替身：模块顶层注入一次（同进程内共享 handlers 表）
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
const { registerIpcHandlers } = require(join(ROOT, 'dist/main/ipc-handlers.js'));

function register(db) {
  registerIpcHandlers({
    db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: join(tmpdir(), 'er09-world'),
    session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => ({}), notifyModel: () => undefined, notifyApp: () => undefined }),
    period: mod('periodic').createPeriodService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => null, notifyApp: () => undefined }),
    fetchFn: async () => ({}),
  });
}

/** K1 场景（日报/周期共用）：原名被用户笔记占用 + 注入 target_rel 持久化失败 →
 *  解除后重试的返回路径 / 数据库路径 / 重开连接查询 / openLocation 参数必须一致指向
 *  .知行2（内容正确的报告）；用户原笔记保持不变；重复重试不新增文件。 */
function k1Body(kind) {
  const isDaily = kind === 'daily_report';
  const rel = isDaily ? '日报/2025-01-01.md' : '周报/2024-12-30_2025-01-05.md';
  const rel2 = isDaily ? '日报/2025-01-01.知行2.md' : '周报/2024-12-30_2025-01-05.知行2.md';
  return async () => {
    const tmp = join(tmpdir(), `er10-k1-${kind}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const dbPath = join(tmp, 'zhixing.db');
      const vault = join(tmp, 'vault');
      const pre = openDb(dbPath);
      run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
        JSON.stringify(mkContent({ experiences: ['记录'] })));
      run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
               VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`,
        JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [], bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 } }));
      run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending', ?, 'pending', 0, 't', 't')`,
        isDaily ? 't1' : 'p1t', kind, isDaily ? 'r1' : 'p1', rel, vault);
      pre.close();
      mkdirSync(join(vault, isDaily ? '日报' : '周报'), { recursive: true });
      const db = openDb(dbPath);
      settingsMod.setPlainSettings(db, { obsidianDir: vault });
      // 1) 原名文件 = 用户已有笔记（内容不同）
      const userFile = join(vault, rel);
      writeFileSync(userFile, 'USER EXISTING NOTE', 'utf8');
      // 2) 注入：仅拒绝 target_rel 持久化
      run(db, `CREATE TRIGGER fail_rel BEFORE UPDATE OF target_rel ON export_tasks
               BEGIN SELECT RAISE(ABORT, 'injected path persistence failure'); END`);
      const r1 = await obsidian.runExportTask(db, isDaily ? 't1' : 'p1t', '0.1.0');
      assert.equal(r1.ok, false, '首次导出：路径持久化失败必须明确返回');
      assert.ok((r1.error ?? '').includes('持久化失败'), r1.error);
      assert.ok(existsSync(join(vault, rel2)), '.知行2 报告已真实生成');
      assert.equal(readFileSync(join(vault, rel), 'utf8'), 'USER EXISTING NOTE', '用户原笔记不被覆盖');
      const mid = get(db, `SELECT status, target_rel FROM export_tasks WHERE id = ?`, isDaily ? 't1' : 'p1t');
      assert.notEqual(mid.status, 'done', '持久化失败不得标记 done（保持可恢复）');
      // 3) 解除故障 → 重试：返回路径与落库路径一致
      run(db, `DROP TRIGGER fail_rel`);
      const r2 = await obsidian.retryExportTask(db, isDaily ? 't1' : 'p1t', '0.1.0');
      assert.equal(r2.ok, true, r2.error);
      assert.equal(r2.status, 'done');
      assert.ok(r2.targetRel.includes('.知行2'), `返回实际路径（${r2.targetRel}）`);
      assert.equal(get(db, `SELECT target_rel, status FROM export_tasks WHERE id = ?`, isDaily ? 't1' : 'p1t').target_rel, r2.targetRel, 'K1 核心：实际路径落库');
      assert.equal(readFileSync(join(vault, rel), 'utf8'), 'USER EXISTING NOTE', '原笔记仍不变');
      // 4) 重新打开连接后查询一致 + openLocation 参数一致
      db.close();
      const db2 = openDb(dbPath);
      register(db2);
      const reopened = get(db2, `SELECT target_rel FROM export_tasks WHERE id = ?`, isDaily ? 't1' : 'p1t');
      assert.equal(reopened.target_rel, r2.targetRel, '重开连接查询一致');
      shellCalls.length = 0;
      const loc = await handlers.get('export:openLocation')({}, { taskId: isDaily ? 't1' : 'p1t' });
      assert.equal(loc.ok, true, JSON.stringify(loc));
      assert.ok(shellCalls[0].endsWith('.知行2.md'), `定位实际发布文件（${shellCalls[0]}）`);
      assert.equal(readFileSync(shellCalls[0], 'utf8').includes('覆盖范围'), true, '定位到的是内容正确的报告');
      // 5) 重复重试：不新增文件、仍 done、路径一致
      const filesBefore = readFileSync(join(vault, rel2), 'utf8');
      const r3 = await obsidian.retryExportTask(db2, isDaily ? 't1' : 'p1t', '0.1.0');
      assert.equal(r3.ok, true);
      assert.equal(r3.targetRel, r2.targetRel, '重复重试路径一致');
      assert.equal(readFileSync(join(vault, rel2), 'utf8'), filesBefore, '文件不重复生成');
      db2.close();
    } finally {
      rmTmp(tmp);
    }
  };
}

test('K1 日报：幂等恢复落库实际路径；解除后四处一致；原笔记不变；重复重试稳定', k1Body('daily_report'));
test('K1 周期报告：幂等恢复落库实际路径；解除后四处一致；原笔记不变；重复重试稳定', k1Body('period_report'));

test('K1 完成状态提交失败：不标记 done；解除后重试恢复一致', async () => {
  const tmp = join(tmpdir(), `er10-k1c-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const vault = join(tmp, 'vault');
    mkdirSync(vault, { recursive: true });
    const pre = openDb(dbPath);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('t1','daily_report','r1','日报/2025-01-01.md','pending',?,'pending',0,'t','t')`, vault);
    pre.close();
    const db = openDb(dbPath);
    settingsMod.setPlainSettings(db, { obsidianDir: vault });
    // 注入：拒绝 done 状态提交（路径已落库之后的那一步）
    run(db, `CREATE TRIGGER fail_done BEFORE UPDATE ON export_tasks
             WHEN NEW.status = 'done'
             BEGIN SELECT RAISE(ABORT, 'injected done commit failure'); END`);
    const r1 = await obsidian.runExportTask(db, 't1', '0.1.0');
    assert.equal(r1.ok, false, '完成状态提交失败必须明确返回');
    assert.ok((r1.error ?? '').includes('持久化失败'), r1.error);
    const mid = get(db, `SELECT status FROM export_tasks WHERE id='t1'`);
    assert.notEqual(mid.status, 'done', '不得假报完成');
    assert.ok(existsSync(join(vault, '日报', '2025-01-01.md')), '文件已发布（可恢复状态）');
    // 解除 → 重试：同内容幂等分支 → 落库 + done 一致
    run(db, `DROP TRIGGER fail_done`);
    const r2 = await obsidian.retryExportTask(db, 't1', '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.targetRel, '日报/2025-01-01.md');
    assert.equal(get(db, `SELECT status, target_rel FROM export_tasks WHERE id='t1'`).status, 'done');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('K1 遗留 done/旧路径任务：重试自我纠正到实际路径（不永久停留错误状态）', async () => {
  const tmp = join(tmpdir(), `er10-k1l-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const vault = join(tmp, 'vault');
    mkdirSync(join(vault, '日报'), { recursive: true });
    const pre = openDb(dbPath);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    // 遗留状态：done + 旧路径（指向用户笔记）+ 内容 hash 为真实报告 hash（模拟第九轮审阅实测遗留）
    const content = mkContent({ experiences: ['记录'] });
    const markdown = obsidian.reportToMarkdown({ date: '2025-01-01', rev: 1, content, model: 'm', promptVersion: 'v1', appVersion: '0.1.0' });
    const payloadHash = obsidian.sha256Hex(Buffer.from(markdown, 'utf8'));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
             VALUES ('t1','daily_report','r1','日报/2025-01-01.md',?,?,'done',1,'t','t','t')`, payloadHash, vault);
    pre.close();
    const db = openDb(dbPath);
    settingsMod.setPlainSettings(db, { obsidianDir: vault });
    // 用户笔记占用旧路径（内容不同）
    writeFileSync(join(vault, '日报', '2025-01-01.md'), 'USER EXISTING NOTE', 'utf8');
    // 修复前：retry 直接 done/旧路径（提前返回）；修复后：核验不一致 → 自我纠正
    const r = await obsidian.retryExportTask(db, 't1', '0.1.0');
    assert.equal(r.ok, true, r.error);
    assert.ok(r.targetRel.includes('.知行2'), `自我纠正到实际路径（${r.targetRel}）`);
    assert.equal(get(db, `SELECT target_rel FROM export_tasks WHERE id='t1'`).target_rel, r.targetRel, '纠正后路径落库');
    assert.equal(readFileSync(join(vault, '日报', '2025-01-01.md'), 'utf8'), 'USER EXISTING NOTE', '用户笔记保持不变');
    assert.ok(readFileSync(join(vault, '日报', '2025-01-01.知行2.md'), 'utf8').includes('覆盖范围'), '报告文件内容正确');
    // 再次重试：核验一致 → done/同路径（稳定）
    const r2 = await obsidian.retryExportTask(db, 't1', '0.1.0');
    assert.equal(r2.ok, true);
    assert.equal(r2.targetRel, r.targetRel);
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// K2：绑定后首次导出的状态更新失败——尽力写回 failed + 原始错误（页面重试入口可见）；
// 启动恢复路径同样写回；解除故障后用户可从页面完成重试；零未处理拒绝。
// ---------------------------------------------------------------------------

test('K2 绑定后首次导出失败：写回 failed+原始错误（视图可重试）；解除后重试完成', async () => {
  const tmp = join(tmpdir(), `er10-k2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const vault = join(tmp, 'vault');
    mkdirSync(vault, { recursive: true });
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
             VALUES ('t1','daily_report','r1','日报/2025-01-01.md','h',NULL,'done',1,'t','t','t')`);
    pre.close();
    const db = openDb(dbPath); // 真实迁移 → done/UNRESOLVED
    register(db);
    // 注入：pending → running 状态更新失败
    run(db, `CREATE TRIGGER fail_running BEFORE UPDATE ON export_tasks
             WHEN OLD.status = 'pending' AND NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'injected running update failure'); END`);
    const r1 = await obsidian.bindTaskTargetAndExport(db, 't1', vault, '0.1.0');
    assert.equal(r1.ok, false);
    assert.ok((r1.error ?? '').includes('无法更新任务状态'), r1.error);
    // K2 核心：任务写回 failed + 原始错误（不再是 pending 无入口、不再 targetUnresolved）
    const t = get(db, `SELECT vault_dir, status, last_error FROM export_tasks WHERE id='t1'`);
    assert.equal(t.vault_dir, vault, '绑定保持');
    assert.equal(t.status, 'failed', '状态写回 failed（页面有重试入口）');
    assert.ok((t.last_error ?? '').includes('无法更新任务状态'), '失败原因与任务状态一致');
    const view = mod('reports').viewReports(mod('reports').reportsByDate(db, '2025-01-01'));
    assert.equal(view[0].exportTask.status, 'failed', '视图可见 failed（重试入口条件）');
    assert.equal(view[0].exportTask.targetUnresolved, false);
    // 解除故障 → 用户入口重试完成
    run(db, `DROP TRIGGER fail_running`);
    const r2 = await obsidian.retryExportTask(db, 't1', '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.ok(existsSync(join(vault, '日报', '2025-01-01.md')), '解除后重试完成');
    await new Promise((r) => setTimeout(r, 250));
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('K2 启动恢复路径同样写回 failed；解除后扫掠恢复；零未处理拒绝', async () => {
  const tmp = join(tmpdir(), `er10-k2r-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason));
  process.on('unhandledRejection', onRejection);
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const vault = join(tmp, 'vault');
    mkdirSync(vault, { recursive: true });
    const pre = openDb(dbPath);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('t1','daily_report','r1','日报/2025-01-01.md','h',?,'pending',0,'t','t')`, vault);
    pre.close();
    const db = openDb(dbPath);
    settingsMod.setPlainSettings(db, { obsidianDir: vault });
    run(db, `CREATE TRIGGER fail_running BEFORE UPDATE ON export_tasks
             WHEN OLD.status = 'pending' AND NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'injected running update failure'); END`);
    await mod('obsidian').recoverPendingExports(db, '0.1.0');
    assert.equal(rejections.length, 0, `零未处理拒绝（${rejections.join(' | ')}）`);
    const t = get(db, `SELECT status, last_error FROM export_tasks WHERE id='t1'`);
    assert.equal(t.status, 'failed', '启动恢复路径同样写回 failed（页面有重试入口）');
    assert.ok((t.last_error ?? '').includes('无法更新任务状态'), 'last_error 与状态一致');
    // 解除故障 → 用户入口重试完成（failed 按合同留给用户显式重试，扫掠不代做）
    run(db, `DROP TRIGGER fail_running`);
    const r = await mod('obsidian').retryExportTask(db, 't1', '0.1.0');
    assert.equal(r.ok, true, r.error);
    assert.equal(get(db, `SELECT status FROM export_tasks WHERE id='t1'`).status, 'done', '用户入口重试完成');
    assert.ok(existsSync(join(vault, '日报', '2025-01-01.md')));
    assert.equal(rejections.length, 0, '全程零未处理拒绝');
    await new Promise((r) => setTimeout(r, 250));
    db.close();
  } finally {
    process.off('unhandledRejection', onRejection);
    rmTmp(tmp);
  }
});
