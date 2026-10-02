// ER-R01 第十轮修正反例（对应 Codex 第十轮审阅 L1/L2）。
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

// electron 替身：模块顶层注入一次（同进程共享 handlers 表）
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
    db, cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, appVersion: '0.1.0', dataDir: join(tmpdir(), 'er11-world'),
    session: mod('session').createSessionService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: { available: () => true, encrypt: (p) => p, decrypt: (e) => e }, fetchFn: async () => ({}), notifyModel: () => undefined, notifyApp: () => undefined }),
    period: mod('periodic').createPeriodService({ db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', getApiKey: () => null, notifyApp: () => undefined }),
    fetchFn: async () => ({}),
  });
}

// ---------------------------------------------------------------------------
// L1：完成处理持久化失败（target_rel / done 提交两类注入 × 日报/周期）——
// 经真实 report:exportRetry IPC 返回后，任务写回 failed+原因（页面重试入口可见）；
// 解除故障后经同一 IPC 完成恢复，路径与文件一致。
// ---------------------------------------------------------------------------

function l1Body(kind, inject) {
  const isDaily = kind === 'daily_report';
  const rel = isDaily ? '日报/2025-01-01.md' : '周报/2024-12-30_2025-01-05.md';
  const taskId = isDaily ? 't1' : 'p1t';
  const refId = isDaily ? 'r1' : 'p1';
  return async () => {
    const tmp = join(tmpdir(), `er11-l1-${kind}-${inject}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const dbPath = join(tmp, 'zhixing.db');
      const vault = join(tmp, 'vault');
      mkdirSync(vault, { recursive: true });
      const pre = openDb(dbPath);
      run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
        JSON.stringify(mkContent({ experiences: ['记录'] })));
      run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
               VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`,
        JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [], bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 } }));
      run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending', ?, 'pending', 0, 't', 't')`, taskId, kind, refId, rel, vault);
      pre.close();
      const db = openDb(dbPath);
      settingsMod.setPlainSettings(db, { obsidianDir: vault });
      register(db);
      // 注入两类完成处理失败之一
      if (inject === 'target_rel') {
        run(db, `CREATE TRIGGER fail_rel BEFORE UPDATE OF target_rel ON export_tasks
                 BEGIN SELECT RAISE(ABORT, 'injected path persistence failure'); END`);
      } else {
        run(db, `CREATE TRIGGER fail_done BEFORE UPDATE ON export_tasks
                 WHEN NEW.status = 'done'
                 BEGIN SELECT RAISE(ABORT, 'injected done commit failure'); END`);
      }
      // 经真实重试 IPC 导出 → 完成处理失败
      const r1 = await handlers.get('report:exportRetry')({}, { taskId });
      assert.equal(r1.ok, false, '完成处理失败必须明确返回');
      assert.ok((r1.detail ?? '').includes('持久化失败'), `detail=${r1.detail} error=${r1.error}`);
      // L1 核心：任务写回 failed + 原始错误（不再滞留 running/last_error=NULL）
      const t = get(db, `SELECT status, last_error FROM export_tasks WHERE id = ?`, taskId);
      assert.equal(t.status, 'failed', `L1 核心：写回 failed（实测 ${JSON.stringify(t)}）`);
      assert.ok((t.last_error ?? '').includes('持久化失败'), 'last_error 与原因一致');
      // 页面视图：failed → 重试入口可见
      const view = isDaily
        ? mod('reports').viewReports(mod('reports').reportsByDate(db, '2025-01-01'), db)[0]
        : mod('periodic').listPeriodReports(db).find((x) => x.id === refId);
      assert.equal(view.exportTask.status, 'failed', '视图 failed（重试入口条件成立）');
      // 解除故障 → 经同一用户入口完成恢复：路径与文件一致
      run(db, `DROP TRIGGER IF EXISTS fail_rel`);
      run(db, `DROP TRIGGER IF EXISTS fail_done`);
      const r2 = await handlers.get('report:exportRetry')({}, { taskId });
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(r2.status, 'done');
      const after = get(db, `SELECT target_rel, status FROM export_tasks WHERE id = ?`, taskId);
      assert.equal(after.status, 'done');
      assert.equal(after.target_rel, r2.targetRel, '落库路径与返回路径一致');
      assert.ok(existsSync(join(vault, r2.targetRel.split('/').join(pathSep()))), '文件真实存在');
      assert.equal(readFileSync(join(vault, r2.targetRel.split('/').join(pathSep())), 'utf8').includes('覆盖范围'), true, '内容为正确报告');
      await new Promise((r) => setTimeout(r, 250));
      db.close();
    } finally {
      rmTmp(tmp);
    }
  };
}
function pathSep() { return process.platform === 'win32' ? '\\' : '/'; }

test('L1 日报 × target_rel 持久化失败：写回 failed（页面可重试）→ 解除后恢复一致', l1Body('daily_report', 'target_rel'));
test('L1 日报 × done 提交失败：写回 failed（页面可重试）→ 解除后恢复一致', l1Body('daily_report', 'done'));
test('L1 周期 × target_rel 持久化失败：写回 failed（页面可重试）→ 解除后恢复一致', l1Body('period_report', 'target_rel'));
test('L1 周期 × done 提交失败：写回 failed（页面可重试）→ 解除后恢复一致', l1Body('period_report', 'done'));

// ---------------------------------------------------------------------------
// L2：遗留 done/旧路径（正确报告已在避让路径）——启动恢复不改变；视图透传不一致；
// openLocation 拒绝定位原笔记；页面「重新核验导出」完成纠正。日报与周期都覆盖。
// ---------------------------------------------------------------------------

function l2Body(kind) {
  const isDaily = kind === 'daily_report';
  const rel = isDaily ? '日报/2025-01-01.md' : '周报/2024-12-30_2025-01-05.md';
  const rel2 = isDaily ? '日报/2025-01-01.知行2.md' : '周报/2024-12-30_2025-01-05.知行2.md';
  const taskId = isDaily ? 't1' : 'p1t';
  const refId = isDaily ? 'r1' : 'p1';
  return async () => {
    const tmp = join(tmpdir(), `er11-l2-${kind}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const dbPath = join(tmp, 'zhixing.db');
      const vault = join(tmp, 'vault');
      mkdirSync(join(vault, isDaily ? '日报' : '周报'), { recursive: true });
      const pre = openDb(dbPath);
      run(pre, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
               VALUES ('r1','2025-01-01',1,'s',?,'m','v1',1,'2025-01-01')`,
        JSON.stringify(mkContent({ experiences: ['记录'] })));
      run(pre, `INSERT INTO period_reports (id, kind, period_start, period_end, content_json, created_at)
               VALUES ('p1','weekly','2024-12-30','2025-01-05',?,'t')`,
        JSON.stringify({ coverage: 'c', highlights: ['h'], patterns: [], open_questions: [], bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 } }));
      // 遗留状态：done + 旧路径（用户笔记占用）+ 正确报告已在 .知行2 + content_hash 为真实报告 hash
      const correctMarkdown = isDaily
        ? obsidian.reportToMarkdown({ date: '2025-01-01', rev: 1, content: mkContent({ experiences: ['记录'] }), model: 'm', promptVersion: 'v1', appVersion: '0.1.0' })
        : obsidian.periodReportToMarkdown({
            id: 'p1', kind: 'weekly', periodStart: '2024-12-30', periodEnd: '2025-01-05', label: '',
            coverage: 'c', highlights: ['h'], patterns: [], openQuestions: [],
            bindings: { daily_report_ids: [], model: 'm', prompt_version: 'v1', rev: 1 },
            stale: false, exportTask: null, createdAt: 't',
          }, '0.1.0');
      const contentHash = obsidian.sha256Hex(Buffer.from(correctMarkdown, 'utf8'));
      run(pre, `INSERT INTO export_tasks (id, kind, ref_id, target_rel, content_hash, vault_dir, status, attempts, created_at, updated_at, done_at)
               VALUES (?, ?, ?, ?, ?, ?, 'done', 1, 't', 't', 't')`, taskId, kind, refId, rel, contentHash, vault);
      pre.close();
      const db = openDb(dbPath);
      settingsMod.setPlainSettings(db, { obsidianDir: vault });
      writeFileSync(join(vault, rel), 'USER NOTE', 'utf8');                       // 旧路径 = 用户笔记
      mkdirSync(join(vault, rel2.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(vault, rel2), correctMarkdown, 'utf8');                  // 正确报告已在避让路径（内容一致）
      register(db);
      // (a) 启动恢复：不改变、不报错（done 不在扫掠范围；缺任务补建不适用）
      await mod('obsidian').recoverPendingExports(db, '0.1.0');
      assert.equal(get(db, `SELECT status, target_rel FROM export_tasks WHERE id = ?`, taskId).target_rel, rel, '启动恢复不改变遗留状态');
      // (b) 视图透传不一致（页面据此显示「重新核验导出」而非「显示位置」）
      const view = isDaily
        ? mod('reports').viewReports(mod('reports').reportsByDate(db, '2025-01-01'), db)[0]
        : mod('periodic').listPeriodReports(db).find((x) => x.id === refId);
      assert.equal(view.exportTask.targetInconsistent, true, 'L2 核心：不一致状态透传视图');
      // (c) openLocation 拒绝定位原笔记
      shellCalls.length = 0;
      const loc1 = await handlers.get('export:openLocation')({}, { taskId });
      assert.equal(loc1.ok, false, '不得把用户笔记当作已验证报告定位');
      assert.equal(shellCalls.length, 0, 'shell 零调用');
      assert.ok(/不一致|重新核验/.test(loc1.detail ?? ''), loc1.detail);
      // (d) 页面入口「重新核验导出」→ 纠正到实际路径
      const r = await handlers.get('report:exportRetry')({}, { taskId });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.status === 'done' && r.targetRel.includes('.知行2'), `纠正到避让路径（${r.targetRel}）`);
      assert.equal(get(db, `SELECT target_rel FROM export_tasks WHERE id = ?`, taskId).target_rel, r.targetRel, '纠正后路径落库');
      // (e) openLocation 定位正确报告；用户笔记保持不变
      shellCalls.length = 0;
      const loc2 = await handlers.get('export:openLocation')({}, { taskId });
      assert.equal(loc2.ok, true, JSON.stringify(loc2));
      assert.ok(shellCalls[0].endsWith('.知行2.md'), `定位正确报告（${shellCalls[0]}）`);
      assert.equal(readFileSync(join(vault, rel), 'utf8'), 'USER NOTE', '用户笔记保持不变');
      assert.equal(readFileSync(join(vault, rel2), 'utf8').includes('覆盖范围'), true, '报告内容正确');
      // (f) 重启（重开连接）后视图一致、不再要求核验
      db.close();
      const db2 = openDb(dbPath);
      const view2 = isDaily
        ? mod('reports').viewReports(mod('reports').reportsByDate(db2, '2025-01-01'), db2)[0]
        : mod('periodic').listPeriodReports(db2).find((x) => x.id === refId);
      assert.equal(view2.exportTask.targetInconsistent, false, '纠正后视图一致');
      assert.equal(view2.exportTask.targetRel, r.targetRel, '路径跨重启保持');
      db2.close();
    } finally {
      rmTmp(tmp);
    }
  };
}

test('L2 日报遗留 done/旧路径：启动恢复→视图透传→定位拒绝→页面纠正→定位正确报告', l2Body('daily_report'));
test('L2 周期遗留 done/旧路径：启动恢复→视图透传→定位拒绝→页面纠正→定位正确报告', l2Body('period_report'));
