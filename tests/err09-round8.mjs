// ER-R01 第八轮修正反例（对应 Codex 第八轮审阅 J1/J2）。
// 每项：修复前失败 / 修复后通过；隔离数据库、真实 IPC 处理函数（electron 替身）、故障注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
function mkContent(over = {}) {
  return {
    coverage: 'c', experiences: [], feelings: [], keep_practices: [], open_questions: [],
    related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [], fact_sources: [],
    ...over,
  };
}

// electron 替身：模块顶层注入一次（ipc-handlers 模块只加载一次，绑定到本表）
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
    db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: tmp0(),
    session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => ({}), notifyModel: () => undefined, notifyApp: () => undefined }),
    period: mod('periodic').createPeriodService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => null, notifyApp: () => undefined }),
    fetchFn: async () => ({}),
  });
}
let worldSeq = 0;
function tmp0() {
  return join(tmpdir(), `er09-world-${worldSeq++}`);
}

// ---------------------------------------------------------------------------
// J1：状态重置注入失败——不得留下"B 目录 + done"半完成状态；解除故障后重试真正核验
// ---------------------------------------------------------------------------

test('J1 重置失败注入：无 B/done 半完成状态（回滚保持 UNRESOLVED）；解除后重试真正核验', async () => {
  const tmp = join(tmpdir(), `er09-j1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    // 模拟 v3：周期报告 + done/NULL 任务（真实迁移 → done/UNRESOLVED）
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
             VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`,
      JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [], bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 } }));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
             VALUES ('pt1','period_report','p1','周报/2024-12-30_2025-01-05.md','h',NULL,'done',1,'t','t','t')`);
    pre.close();
    const db = openDb(dbPath);
    register(db);
    const vaultB = join(tmp, 'B');
    mkdirSync(vaultB, { recursive: true });
    const obsidian = mod('obsidian');
    // 注入：仅拒绝"done → pending"的状态重置（第二次 UPDATE），放行 vault_dir 更新
    run(db, `CREATE TRIGGER fail_reset BEFORE UPDATE ON export_tasks
             WHEN OLD.status = 'done' AND NEW.status = 'pending'
             BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`);
    const r1 = await obsidian.bindTaskTargetAndExport(db, 'pt1', vaultB, '0.1.0');
    assert.equal(r1.ok, false, '重置失败必须明确返回');
    assert.ok((r1.error ?? '').includes('绑定目标失败'), r1.error);
    // J1 核心：不得留下 B/done 半完成状态（事务整体回滚，目标未解决状态与解决入口保持）
    const t = get(db, `SELECT vault_dir, status, done_at FROM export_tasks WHERE id='pt1'`);
    assert.equal(t.vault_dir, 'UNRESOLVED', `目标必须回滚为 UNRESOLVED（实测 ${t.vault_dir}）`);
    assert.equal(t.status, 'done', '状态回滚为 done');
    assert.ok(t.done_at, '旧完成时间保持（未产生假的新完成）');
    assert.ok(!existsSync(join(vaultB, '周报', '2024-12-30_2025-01-05.md')), 'B 中不得有文件');
    const row = mod('periodic').listPeriodReports(db).find((x) => x.id === 'p1');
    assert.equal(row.exportTask.targetUnresolved, true, '解决入口保持可见');
    shellCalls.length = 0;
    const loc1 = await handlers.get('export:openLocation')({}, { taskId: 'pt1' });
    assert.equal(loc1.ok, false, '半完成状态下打开位置被拒（而非定位错误文件）');
    // 解除故障 → 用户入口重试：真正核验并完成
    run(db, `DROP TRIGGER fail_reset`);
    const r2 = await obsidian.bindTaskTargetAndExport(db, 'pt1', vaultB, '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.status, 'done');
    assert.ok(existsSync(join(vaultB, '周报', '2024-12-30_2025-01-05.md')), '解除故障后文件真实生成');
    shellCalls.length = 0;
    const loc2 = await handlers.get('export:openLocation')({}, { taskId: 'pt1' });
    assert.equal(loc2.ok, true);
    assert.ok(shellCalls[0].startsWith(vaultB), '定位到绑定目录');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

test('J1 日报任务同样受事务保护（done/UNRESOLVED 注入重置失败 → 回滚）', async () => {
  const tmp = join(tmpdir(), `er09-j1d-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const pre = openDb(dbPath);
    run(pre, `UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
             VALUES ('dt1','daily_report','r1','日报/2025-01-01.md','h',NULL,'done',1,'t','t','t')`);
    pre.close();
    const db = openDb(dbPath);
    register(db);
    const vaultB = join(tmp, 'B');
    mkdirSync(vaultB, { recursive: true });
    run(db, `CREATE TRIGGER fail_reset BEFORE UPDATE ON export_tasks
             WHEN OLD.status = 'done' AND NEW.status = 'pending'
             BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`);
    const r1 = await mod('obsidian').bindTaskTargetAndExport(db, 'dt1', vaultB, '0.1.0');
    assert.equal(r1.ok, false);
    const t = get(db, `SELECT vault_dir, status FROM export_tasks WHERE id='dt1'`);
    assert.equal(t.vault_dir, 'UNRESOLVED', '日报任务同样回滚');
    assert.equal(t.status, 'done');
    assert.ok(!existsSync(join(vaultB, '日报', '2025-01-01.md')), '无半成品文件');
    run(db, `DROP TRIGGER fail_reset`);
    const r2 = await mod('obsidian').bindTaskTargetAndExport(db, 'dt1', vaultB, '0.1.0');
    assert.equal(r2.ok, true, r2.error);
    assert.ok(existsSync(join(vaultB, '日报', '2025-01-01.md')), '解除后核验完成');
    db.close();
  } finally {
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// J2：启动恢复的异步合同——running 状态写入失败不得产生未处理拒绝；
// 单任务失败不阻断其他任务；故障解除后重启扫掠可恢复。真实 recoverPendingExports 链路。
// ---------------------------------------------------------------------------

test('J2 注入 running 更新失败：零未处理拒绝、其他任务完成、解除后扫掠恢复', async () => {
  const tmp = join(tmpdir(), `er09-j2-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  // 收集未处理拒绝（探针仅用于断言本测试期间为零）
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason));
  process.on('unhandledRejection', onRejection);
  try {
    const dbPath = join(tmp, 'zhixing.db');
    const vault = join(tmp, 'vault');
    const pre = openDb(dbPath);
    // 注意：本场景不模拟 v3 升级（否则 NULL 目标会被正确迁移为 UNRESOLVED——那是另一条合同）。
    // A/B 代表当前版本的普通任务，目标明确绑定到测试 Vault。
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('a','daily_report','ghost','日报/gone.md','h',?,'pending',0,'t','t')`, vault);
    // 任务 B：pending，正常可完成
    run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
      JSON.stringify(mkContent({ experiences: ['记录'] })));
    run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
             VALUES ('b','daily_report','r1','日报/2025-01-01.md','h',?,'pending',0,'t','t')`, vault);
    // 周期报告：无任何导出任务（覆盖本轮新增的扫掠补建路径）
    run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
             VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`,
      JSON.stringify({ coverage: 'c', highlights: [], patterns: [], open_questions: [], bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 } }));
    pre.close();
    mkdirSync(vault, { recursive: true });
    const db = openDb(dbPath);
    settingsMod.setPlainSettings(db, { obsidianDir: vault });
    // 注入：pending → running 的状态更新失败（bump('running') 路径）
    run(db, `CREATE TRIGGER fail_running BEFORE UPDATE ON export_tasks
             WHEN OLD.status = 'pending' AND NEW.status = 'running'
             BEGIN SELECT RAISE(ABORT, 'injected running update failure'); END`);
    // 真实启动调用链（index.ts 同款入口）
    await mod('obsidian').recoverPendingExports(db, '0.1.0');
    assert.equal(rejections.length, 0, `J2 核心：未处理拒绝必须为零（实测 ${rejections.join(' | ')}）`);
    // 注入期间（K2 合同更新）：bump('running') 失败会尽力写回 failed + 原始错误——
    // B 与扫掠补建任务都变为 failed（页面有重试入口），不再是不可见的 pending
    const a = get(db, `SELECT status, attempts FROM export_tasks WHERE id='a'`);
    assert.ok(a, '任务 A 仍在');
    const b = get(db, `SELECT status, last_error FROM export_tasks WHERE id='b'`);
    assert.equal(b.status, 'failed', '注入期间 B 写回 failed（K2：页面有重试入口）');
    assert.ok((b.last_error ?? '').includes('无法更新任务状态'), '失败原因可见');
    const swept = get(db, `SELECT id, status FROM export_tasks WHERE ref_id='p1'`);
    assert.ok(swept, '扫掠已补建周期报告任务');
    assert.equal(swept.status, 'failed', '补建任务同样写回 failed');
    // 解除故障 → 用户入口重试（failed 按合同留给用户显式重试）；扫掠不代做、不重复建任务
    run(db, `DROP TRIGGER fail_running`);
    await mod('obsidian').recoverPendingExports(db, '0.1.0');
    assert.equal(get(db, `SELECT COUNT(*) AS n FROM export_tasks WHERE ref_id='p1'`).n, 1, '扫掠不重复建任务');
    const obsidian = mod('obsidian');
    const rb = await obsidian.retryExportTask(db, 'b', '0.1.0');
    assert.equal(rb.ok, true, rb.error);
    const rp = await obsidian.retryExportTask(db, swept.id, '0.1.0');
    assert.equal(rp.ok, true, rp.error);
    assert.equal(get(db, `SELECT status FROM export_tasks WHERE id='b'`).status, 'done', `B 恢复完成：${JSON.stringify(all(db, `SELECT id, status, attempts, last_error FROM export_tasks`))}`);
    assert.equal(get(db, `SELECT status FROM export_tasks WHERE ref_id='p1'`).status, 'done', '补建任务完成');
    assert.ok(existsSync(join(tmp, 'vault', '日报', '2025-01-01.md')), '日报文件生成');
    assert.ok(existsSync(join(tmp, 'vault', '周报', '2024-12-30_2025-01-05.md')), '周期报告文件生成');
    assert.equal(rejections.length, 0, '全程零未处理拒绝');
    await new Promise((r) => setTimeout(r, 250));
    db.close();
  } finally {
    process.off('unhandledRejection', onRejection);
    rmTmp(tmp);
  }
});
