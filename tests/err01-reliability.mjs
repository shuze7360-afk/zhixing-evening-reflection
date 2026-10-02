// ER-R01 反例测试：R1—R5（可靠性）。
// 每个用例对应审查发现；修复前运行应失败（before 证据），修复后应全部通过。
// 全部使用隔离数据库 / 临时目录 / mock fetch，不触碰真实数据、不发真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const dist = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const mod = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const { openDb, get, all, run } = require(join(ROOT, 'dist/main/db.js'));
const settingsMod = require(join(ROOT, 'dist/main/settings.js'));

const CRYPTOR_ID = {
  available: () => true,
  encrypt: (p) => p, // 恒等加密：让哨兵明文直接出现在密文字段，便于字节级校验
  decrypt: (e) => e,
};

function rmTmp(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

function freshDb(tmpName) {
  const userData = join(tmpdir(), `err01-${tmpName}-${Math.random().toString(36).slice(2, 8)}`);
  const db = openDb(join(userData, 'zhixing.db'));
  return { userData, db };
}

function sseResponse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader() { return { read() { if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) }); return Promise.resolve({ done: true }); } }; } },
  };
}

// ---------------------------------------------------------------------------
// R1 恢复安全化
// ---------------------------------------------------------------------------

test('R1-a 同源恢复被拒绝（把当前库自己选为恢复源）', () => {
  const { userData, db } = freshDb('r1a');
  try {
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe', '1', '2026-10-01T00:00:00Z')`);
    const backupMod = mod('backup');
    const marker = join(userData, 'pending-restore.json');
    writeFileSync(marker, JSON.stringify({ from: join(userData, 'zhixing.db') }));
    const applied = backupMod.applyPendingRestore(userData);
    // 期望：拒绝同源，数据库原样保留、可读
    assert.equal(applied.restored, false, '同源恢复必须被拒绝');
    assert.ok(applied.error, '必须返回明确错误');
    assert.ok(existsSync(join(userData, 'zhixing.db')), '当前库仍存在');
    assert.equal(get(db, `SELECT value FROM settings WHERE key='probe'`).value, '1', '原记录仍可读');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

test('R1-b 复制失败不得移走当前库、不得静默空库启动', () => {
  const { userData, db } = freshDb('r1b');
  try {
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe', '1', '2026-10-01T00:00:00Z')`);
    const backupMod = mod('backup');
    // 让"复制源"是一个目录：existsSync 通过，copyFileSync 必然失败（复现审查中的复制失败）
    const badSource = join(userData, 'bad-source');
    mkdirSync(badSource, { recursive: true });
    const marker = join(userData, 'pending-restore.json');
    writeFileSync(marker, JSON.stringify({ from: badSource }));
    const applied = backupMod.applyPendingRestore(userData);
    // 期望：报告失败 + 当前库原样保留（老实现：rename 走了当前库、copy 失败、库消失）
    assert.equal(applied.restored, false);
    assert.ok(applied.error, '必须返回明确错误（不得静默）');
    assert.ok(existsSync(join(userData, 'zhixing.db')), '当前库不得被移走');
    assert.equal(get(db, `SELECT value FROM settings WHERE key='probe'`).value, '1', '原记录仍可读');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

test('R1-c 成功恢复后旧安全副本保留；失败后无半成品发布', () => {
  const { userData, db } = freshDb('r1c');
  try {
    const backupMod = mod('backup');
    run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('probe', '1', '2026-10-01T00:00:00Z')`);
    // 造一个合法备份
    const outDir = join(userData, 'backups');
    mkdirSync(outDir, { recursive: true });
    const r = backupMod.backupDatabase(db, outDir, userData);
    assert.equal(r.ok, true, r.error);
    db.close();
    // 修改当前库（制造差异），再请求恢复
    const db2 = openDb(join(userData, 'zhixing.db'));
    run(db2, `INSERT INTO settings (key, value, updated_at) VALUES ('after-backup', '1', '2026-10-01T00:00:00Z')`);
    const req = backupMod.requestRestore(userData, r.file);
    assert.equal(req.ok, true, req.error);
    db2.close(); // 独占检查要求释放句柄（Windows）
    const applied = backupMod.applyPendingRestore(userData);
    assert.equal(applied.restored, true);
    assert.ok(existsSync(join(userData, 'zhixing.db.before-restore')), '旧安全副本必须保留');
    const reopened = openDb(join(userData, 'zhixing.db'));
    assert.equal(get(reopened, `SELECT COUNT(*) AS n FROM settings WHERE key='after-backup'`).n, 0, '恢复内容生效');
    reopened.close();
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

// ---------------------------------------------------------------------------
// R2 备份脱敏（哨兵）
// ---------------------------------------------------------------------------

test('R2-a 备份不含凭据（表级 + 文件字节级哨兵校验），普通数据完整', () => {
  const { userData, db } = freshDb('r2a');
  try {
    settingsMod.setApiKey(db, CRYPTOR_ID, 'SENTINEL-KEY-1234567890-ABCDEF');
    const { run } = dist('db');
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, formal, created_at)
             VALUES ('d-sent', '2026-10-01', 1, 's', '{"coverage":"c"}', 1, '2026-10-01T00:00:00Z')`);
    const outDir = join(userData, 'backups');
    mkdirSync(outDir, { recursive: true });
    const backupMod = mod('backup');
    const r = backupMod.backupDatabase(db, outDir, userData);
    assert.equal(r.ok, true, r.error);
    const bytes = readFileSync(r.file);
    assert.ok(!bytes.includes('SENTINEL-KEY'), '备份文件字节不得包含哨兵凭据');
    const probe = new (require('node:sqlite').DatabaseSync)(r.file, { readOnly: true });
    try {
      const rows = probe.prepare(`SELECT key FROM settings`).all().map((x) => x.key);
      assert.ok(!rows.includes('api_key_enc'), '备份 settings 表不得含凭据字段');
      assert.equal(probe.prepare(`SELECT COUNT(*) AS n FROM daily_reports`).get().n, 1, '日报完整保留');
    } finally {
      probe.close();
    }
    // 恢复校验通过（恢复后要求重配密钥是预期行为）
    assert.equal(backupMod.validateRestoreSource(r.file).ok, true);
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

// ---------------------------------------------------------------------------
// R3 导出不覆盖 + 目录校验
// ---------------------------------------------------------------------------

test('R3-a 发布原语：目标已存在时不得覆盖，必须避让出新名', async () => {
  const tmp = join(tmpdir(), `err01-r3a-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(tmp, { recursive: true });
    const target = join(tmp, '日报', '2026-10-01.md');
    mkdirSync(join(tmp, '日报'), { recursive: true });
    writeFileSync(target, '用户自己的内容', 'utf8');
    const obsidian = mod('obsidian');
    assert.ok(typeof obsidian.publishFileNoClobber === 'function', '缺少无覆盖发布原语');
    const tmpSrc = join(tmp, 'staging.md');
    writeFileSync(tmpSrc, '应用导出的内容', 'utf8');
    const r = await obsidian.publishFileNoClobber(tmpSrc, target);
    // 契约：目标已存在 → published=false + exists=true（不写入），由调用方避让；
    // link 语义保证检查与发布之间没有覆盖窗口（并发场景由 runExportTask 覆盖）。
    assert.equal(r.published, false, '目标已存在时不得写入');
    assert.equal(r.exists, true, '必须报告目标已存在');
    assert.equal(readFileSync(target, 'utf8'), '用户自己的内容', '用户内容必须原样保留');
    assert.ok(existsSync(tmpSrc), '暂存文件保留（供调用方避让后重用）');
    // 新名发布成功
    const r2 = await obsidian.publishFileNoClobber(tmpSrc, target.replace('.md', '.知行2.md'));
    assert.equal(r2.published, true);
    assert.equal(readFileSync(r2.finalPath, 'utf8'), '应用导出的内容');
  } finally {
    rmTmp(tmp);
  }
});

test('R3-b Vault 根目录不存在时明确失败；重试导出零模型调用', async () => {
  const { userData, db } = freshDb('r3b');
  try {
    const backuplessVault = join(userData, 'vault-not-exist');
    settingsMod.setPlainSettings(db, { obsidianDir: backuplessVault });
    const reportId = 'd-r3b';
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES (?, '2026-10-01', 1, 's', '{"coverage":"c","experiences":[],"feelings":[],"keep_practices":[],"open_questions":[],"related_ideas":[],"ai_notes":[],"action_candidates":[],"actions_accepted":[]}', NULL, NULL, 1, '2026-10-01T00:00:00Z')`, reportId);
    const obsidian = mod('obsidian');
    const taskId = obsidian.createExportTask(db, { refId: reportId, targetRel: '日报/2026-10-01.md', contentHash: 'pending' });
    const r = await obsidian.runExportTask(db, taskId, '0.1.0');
    assert.equal(r.ok, false, 'Vault 不存在必须明确失败（不得静默创建）');
    assert.ok((r.error ?? '').includes('导出目录'), `错误需可读：${r.error}`);
    assert.equal(existsSync(backuplessVault), false, '不得创建目录');
    // 重试 = 纯文件操作：模型请求计数不变
    const before = all(db, `SELECT id FROM model_requests`).length;
    const r2 = await obsidian.runExportTask(db, taskId, '0.1.0');
    assert.equal(r2.ok, false);
    const after = all(db, `SELECT id FROM model_requests`).length;
    assert.equal(after, before, '重试导出不得新增模型请求');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

// ---------------------------------------------------------------------------
// R4 请求生命周期
// ---------------------------------------------------------------------------

test('R4-a 半截 SSE（无 DONE/finish_reason）不得计为完整成功', async () => {
  const bigmodel = mod('bigmodel');
  const deltas = [];
  let threw = null;
  try {
    await bigmodel.streamChat(
      { apiKey: 'k', fetchFn: async () => sseResponse([
          'data: {"choices":[{"delta":{"content":"半截回复"}}]}\n\n',
        ]) },
      { messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t) },
    );
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '截断流必须抛错（不得当成功返回）');
  assert.equal(threw.errorClass, 'unknown', '截断归类为结果不明');
  assert.equal(threw.partial, '半截回复', '抛错时必须携带已收到的部分内容');
});

test('R4-b 401：产生模型终态事件、退款、会话可继续操作', async () => {
  const { userData, db } = freshDb('r4b');
  try {
    settingsMod.setPlainSettings(db, { obsidianDir: join(userData, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const events = [];
    const sessionMod = mod('session');
    const svc = sessionMod.createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR_ID,
      fetchFn: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"无效令牌"}}' }),
      notifyModel: (e) => events.push({ ch: 'model', ...e }),
      notifyApp: (e) => events.push({ ch: 'app', type: e.type }),
    });
    const s0 = svc.startChat();
    const sid = s0.snapshot.session.id;
    const r = await svc.send({ sessionId: sid, content: '今天测试 401。' });
    assert.equal(r.ok, false);
    const modelErr = events.find((e) => e.ch === 'model' && e.type === 'error' && e.errorClass === 'auth');
    assert.ok(modelErr, '必须发出 errorClass=auth 的终态事件（供界面清理）');
    const snap = svc.getToday();
    assert.notEqual(snap.session.phase, 'refining');
    // 会话可继续操作（没有被 inflight 卡死）：再次发送不再返回 busy
    const again = await svc.send({ sessionId: sid, content: '换好了新 Key，继续。' });
    assert.notEqual(again.error, 'busy', '终态后不得残留 inflight 锁');
    const usageRows = all(db, `SELECT status FROM usage`);
    assert.ok(usageRows.every((u) => u.status === 'refunded'), '确定性失败必须退款');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

test('R4-c 启动恢复：refining 遗留会话与 running 请求被识别为中断，会话可重新收束', async () => {
  const { userData, db } = freshDb('r4c');
  try {
    const { run } = dist('db');
    run(db, `INSERT INTO sessions (id, date, kind, phase, followup_used, status, prompt_version, model, started_at)
             VALUES ('sx', '2026-10-01', 'chat', 'refining', 0, 'active', 'v1', NULL, '2026-10-01T12:00:00Z')`);
    run(db, `INSERT INTO model_requests (id, session_id, kind, prompt_version, status, created_at)
             VALUES ('rq', 'sx', 'refine', 'v1', 'running', '2026-10-01T12:00:00Z')`);
    const sessionMod = mod('session');
    assert.ok(typeof sessionMod.recoverInterrupted === 'function', '缺少启动中断恢复');
    sessionMod.recoverInterrupted(db);
    const s = get(db, `SELECT phase FROM sessions WHERE id='sx'`);
    assert.equal(s.phase, 'refine_failed', '遗留 refining 必须转为可操作状态');
    const rq = get(db, `SELECT status FROM model_requests WHERE id='rq'`);
    assert.equal(rq.status, 'unknown', '遗留 running 请求 = 结果不明（保留预占，不自动重发）');
    // 恢复后可重新收束（mock 成功）
    const responses = [
      () => jsonRespOk(JSON.stringify({ coverage: '覆盖', experiences: ['x'], feelings: [], keep_practices: [], open_questions: [], related_ideas: [], ai_notes: [], action_candidates: [], actions_accepted: [] })),
    ];
    const svc = sessionMod.createSessionService({
      db, promptsBaseDir: join(ROOT, 'resources'), appVersion: '0.1.0', cryptor: CRYPTOR_ID,
      fetchFn: async () => { const n = responses.shift(); if (!n) throw new Error('no more'); return n(); },
      notifyModel: () => undefined, notifyApp: () => undefined,
    });
    const end = await svc.endSession('sx');
    assert.equal(end.ok, true, `恢复后应可重新收束：${JSON.stringify(end)}`);
    await new Promise((r) => setTimeout(r, 200));
    const after = get(db, `SELECT phase, status FROM sessions WHERE id='sx'`);
    assert.equal(after.status, 'closed', '重新收束成功后关闭');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

function jsonRespOk(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), text: async () => '' };
}
// ---------------------------------------------------------------------------
// R5 预算
// ---------------------------------------------------------------------------

test('R5-a 超预算时测试连接零网络调用', async () => {
  const { userData, db } = freshDb('r5a');
  try {
    settingsMod.setPlainSettings(db, { budgetMonthlyCny: 0.001, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    settingsMod.setApiKey(db, CRYPTOR_ID, 'sk-sentinel-r5a-0000000000');
    let calls = 0;
    const bigmodel = mod('bigmodel');
    assert.ok(typeof bigmodel.testConnectionBudgeted === 'function', '缺少带预算闸的连接测试入口');
    const r = await bigmodel.testConnectionBudgeted(db, {
      apiKey: 'k', fetchFn: async () => { calls++; return { ok: true, status: 200, json: async () => ({ choices: [], usage: {} }) }; },
      price: { inCnyPerMtok: 8, outCnyPerMtok: 8 },
    });
    assert.equal(r.ok, false);
    assert.ok((r.errorClass ?? r.error) === 'budget_paused' || (r.detail ?? '').includes('预算'), '必须以预算原因拒绝');
    assert.equal(calls, 0, '超预算时不得发起任何网络调用');
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

test('R5-b 预占按输入/输出分别计价，且与实际 max_tokens 对齐', () => {
  const { userData, db } = freshDb('r5b');
  try {
    const price = { inCnyPerMtok: 1, outCnyPerMtok: 100 };
    const budget = mod('budget');
    const estIn = 1_000_000; // 1M tokens * 1 元/M = 1 元
    const estOut = 8_192;    // 8192 * 100 元/M = 0.8192 元
    const { usageId, holdCny } = budget.preHold(db, 'r5b', 'chat', estIn, estOut, price);
    assert.ok(Math.abs(holdCny - 1.8192) < 0.0001, `预占应按分价计算 1.8192，实际 ${holdCny}`);
    // 输出预占上限与实际 max_tokens 对齐
    const config = require(join(ROOT, 'dist/shared/config.js'));
    assert.equal(config.OUTPUT_ESTIMATE.refine, config.MAX_OUTPUT_TOKENS, '提炼预占输出上限必须等于实际 max_tokens');
    assert.ok(holdCny > 0);
    void usageId;
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});

test('R5-c 预算判断使用内部精度（不得因两位小数显示造成越界放行）', () => {
  const { userData, db } = freshDb('r5c');
  try {
    settingsMod.setPlainSettings(db, { budgetMonthlyCny: 0.5, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const price = { inCnyPerMtok: 8, outCnyPerMtok: 8 };
    const budget = mod('budget');
    const h1 = budget.preHold(db, 'a', 'chat', 61862, 0, price); // 0.494896
    budget.settle(db, h1.usageId, { prompt_tokens: 61862, completion_tokens: 0 }, 0, 0, price);
    // 剩余 0.005104；再预占 0.006 → 总额 0.500996 > 0.5 必须拒绝
    const check = budget.checkBudget(db, 0.5, 0.006);
    assert.equal(check.allowed, false, `内部精度不得放行越界（spend=${check.spendCny}）`);
  } finally {
    try { db.close(); } catch {}
    rmTmp(userData);
  }
});
