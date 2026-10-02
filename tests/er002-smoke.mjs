// ER-002 离线冒烟测试：不依赖 electron、不发起真实网络请求（fetch 注入 mock）。
// 覆盖：数据库迁移、设置与密钥加密、预算预占/结算/退款/超限、SSE 解析、错误分类、
//       会话状态机（发送→追问→跳过→收束）、提炼 JSON 校验与一次修复、日报导出
//       （原子写/回读核验/幂等重试/重名避让/路径越界）、输入上限、简短模式。
// 运行：npm run test:smoke（先构建主进程再 node --test）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const dist = (p) => require(join(ROOT, 'dist/main', `${p}.js`));
const RESOURCES = join(ROOT, 'resources');

const { openDb, get, all } = dist('db');
const { createSessionService } = dist('session');
const { classifyHttpError, classifyAbort, streamChat, BigModelError } = dist('bigmodel');
const { parseDailyReportJson } = require(join(ROOT, 'dist/shared/schemas.js'));
const { runExportTask, resolveVaultPath, reportToMarkdown } = dist('obsidian');
const budget = dist('budget');
const settingsMod = dist('settings');


/** Windows 下目录可能被杀软/索引器瞬时占用：同步重试删除 */
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

const CRYPTOR = {
  available: () => true,
  encrypt: (p) => Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (e) => Buffer.from(e, 'base64').toString('utf8'),
};

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i < chunks.length) return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
            return Promise.resolve({ done: true });
          },
        };
      },
    },
  };
}

function jsonChatResponse(content, usage) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: usage ?? { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }),
    text: async () => '',
  };
}

const GOOD_REPORT = {
  coverage: '对话模式；共 4 条发言；记录时段 21:30–21:40。',
  experiences: ['修好了耳机，没有直接买新的'],
  feelings: ['有点成就感'],
  keep_practices: ['先查教程再动手'],
  open_questions: [],
  related_ideas: [{ idea: '自己动手解决小问题带来的掌控感', principle_id: 'naval-batch1:focus-say-no', kind: '解读' }],
  ai_notes: ['我猜测你最近在控制开销'],
  action_candidates: [{ action: '明天把教程链接存进收藏夹', rationale: '方便复用' }],
  // 模型违令夹带：解析层必须强制清空（"也许可以"绝不变成已接受）
  actions_accepted: [{ action: '模型擅自塞入的行动', accepted_at: '2026-10-01T00:00:00Z' }],
};

function makeService({ fetchCalls, responses, tmp }) {
  const dbPath = join(tmp, `zhixing-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(dbPath);
  mkdirSync(join(tmp, 'vault'), { recursive: true }); // R3：导出目录必须真实存在
  settingsMod.setPlainSettings(db, {
    obsidianDir: join(tmp, 'vault'),
    budgetMonthlyCny: 20,
    priceInCnyPerMtok: 8,
    priceOutCnyPerMtok: 8,
    priceCheckedAt: '2026-10-01',
  });
  const events = [];
  const fetchFn = async (url, init) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('mock fetch：没有更多预设响应');
    return typeof next === 'function' ? next(url, init) : next;
  };
  const service = createSessionService({
    db,
    promptsBaseDir: RESOURCES,
    appVersion: '0.1.0',
    cryptor: CRYPTOR,
    fetchFn,
    notifyModel: (e) => events.push({ ch: 'model', e }),
    notifyApp: (e) => events.push({ ch: 'app', e }),
  });
  return { db, service, events, fetchCalls };
}

async function settleMicrotasks(ms = 120) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

test('数据库迁移：版本与核心表存在', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    const v = get(db, `SELECT value FROM meta WHERE key='schema_version'`);
    assert.equal(v.value, '4'); // v4（F6 数据迁移；含 v3 S10 每日唯一当前正式版）
    const tables = all(db, `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name);
    for (const t of ['settings', 'sessions', 'messages', 'model_requests', 'usage', 'daily_reports', 'export_tasks']) {
      assert.ok(tables.includes(t), `缺少表 ${t}`);
    }
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('API Key 加密存取：公开视图永不包含密钥', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setApiKey(db, CRYPTOR, 'sk-test-1234567890abcdef');
    assert.equal(settingsMod.getApiKey(db, CRYPTOR), 'sk-test-1234567890abcdef');
    const pub = settingsMod.getPublicSettings(db, 0, 'D:\\x');
    assert.equal(pub.hasApiKey, true);
    assert.ok(!JSON.stringify(pub).includes('sk-test-1234567890abcdef'), '公开设置不得包含密钥');
    // 拒绝明文存储
    assert.ok(!JSON.stringify(all(db, `SELECT value FROM settings`)).includes('sk-test-1234567890abcdef'));
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('预算：预占→结算→超限暂停；确定性失败退款；未知结果保留预占', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { budgetMonthlyCny: 1, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    const price = { inCnyPerMtok: 8, outCnyPerMtok: 8 };

    const h1 = budget.preHold(db, 'r1', 'chat', 10000, 1200, price); // ≈ 0.09 元
    budget.settle(db, h1.usageId, { prompt_tokens: 10000, completion_tokens: 1200 }, 0, 0, price);
    assert.ok(Math.abs(budget.effectiveSpendCny(db) - (11200 / 1e6) * 8) < 0.005, '结算金额按分保留');

    const h2 = budget.preHold(db, 'r2', 'refine', 100000, 3000, price); // 0.824 → 累计 0.914
    budget.refund(db, h2.usageId);
    assert.equal(budget.checkBudget(db, 1, 0.005).allowed, true);

    const h3 = budget.preHold(db, 'r3', 'chat', 50000, 1200, price); // 0.412 → 累计 1.326 > 1
    budget.keepHold(db, h3.usageId);
    // 上限压到 0.5 元：有效占用约 0.502 + 0.005 > 0.5 → 应拒绝
    assert.equal(budget.checkBudget(db, 0.5, 0.005).allowed, false, '超限后应拒绝新调用');
    assert.equal(budget.checkBudget(db, 1, 0.005).allowed, true, '上限内仍可调用');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('SSE 解析：增量累积、usage 捕获、[DONE] 结束', async () => {
  const deltas = [];
  const result = await streamChat(
    { apiKey: 'k', fetchFn: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"今天"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"辛苦了"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"\\n【追问】然后呢？"}}],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}\n\n',
        'data: [DONE]\n\n',
      ]) },
    { messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t) },
  );
  assert.equal(result.content, '今天辛苦了\n【追问】然后呢？');
  assert.equal(result.usage.total_tokens, 16);
  assert.deepEqual(deltas, ['今天', '辛苦了', '\n【追问】然后呢？']);
});

test('错误分类：鉴权/模型/余额/限流/服务端/超时', () => {
  assert.equal(classifyHttpError(401, '{"error":{"code":"1002","message":"无效的 API Key"}}').errorClass, 'auth');
  assert.equal(classifyHttpError(404, '{"error":{"message":"model not found"}}').errorClass, 'model');
  assert.equal(classifyHttpError(429, '{"error":{"message":"余额不足，请充值"}}').errorClass, 'balance');
  assert.equal(classifyHttpError(429, '{"error":{"message":"请求过快"}}').errorClass, 'rate_limit');
  assert.equal(classifyHttpError(500, 'oops').errorClass, 'server');
  const timeoutErr = classifyAbort(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  assert.equal(timeoutErr.errorClass, 'timeout');
  assert.ok(timeoutErr instanceof BigModelError);
});

test('提炼 JSON：容忍围栏、缺失字段给出具体错误', () => {
  const fenced = '好的，这是日报：\n```json\n' + JSON.stringify(GOOD_REPORT) + '\n```\n以上。';
  const okParsed = parseDailyReportJson(fenced);
  assert.equal(okParsed.ok, true);
  assert.equal(okParsed.content.experiences[0], '修好了耳机，没有直接买新的');
  assert.deepEqual(okParsed.content.actions_accepted, [], '模型输出的 actions_accepted 必须被解析层清空');

  const bad = parseDailyReportJson('{"coverage":"","experiences":"不是数组"}');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('coverage')));
  assert.ok(bad.errors.some((e) => e.includes('experiences')));

  assert.equal(parseDailyReportJson('完全不是 JSON').ok, false);
});

test('完整链路（mock）：发送→追问→跳过→结束提炼（一次修复）→日报+导出', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  const fetchCalls = [];
  const responses = [
    // 第一轮反馈（流式，带追问）
    () => sseResponse([
      'data: {"choices":[{"delta":{"content":"修耳机而不是换新，这是挺实在的选择。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\n【展开】自己动手…"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\n【追问】耳机之前是怎么坏的？"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    // 第二轮反馈（用户回答后，不再追问）
    () => sseResponse([
      'data: {"choices":[{"delta":{"content":"原来是线材折损。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\n【追问】这周用过几次耳机？"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    // 跳过追问后的收束反馈（不再追问）
    () => sseResponse([
      'data: {"choices":[{"delta":{"content":"好，那今天就到这里：修而不换，值得保留。"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    // 提炼第一次：无效 JSON
    () => jsonChatResponse('这不是 JSON'),
    // 修复调用：有效 JSON
    () => jsonChatResponse(JSON.stringify(GOOD_REPORT), { prompt_tokens: 500, completion_tokens: 300, total_tokens: 800 }),
  ];
  const { db, service, events } = makeService({ fetchCalls, responses, tmp });

  try {
    const start = service.startChat();
    assert.equal(start.ok, true);
    const sid = start.snapshot.session.id;

    const r1 = await service.send({ sessionId: sid, content: '今天修好了耳机，没买新的，挺有成就感。' });
    assert.equal(r1.ok, true);
    await settleMicrotasks();
    let snap = service.getToday();
    assert.equal(snap.messages.length, 2);
    assert.equal(snap.session.phase, 'followup');
    assert.equal(snap.session.followupUsed, 1);
    assert.ok(snap.messages[1].content.includes('【追问】'));

    const r2 = await service.send({ sessionId: sid, content: '线材折断了，我换了保护套。' });
    assert.equal(r2.ok, true);
    await settleMicrotasks();
    snap = service.getToday();
    assert.equal(snap.session.phase, 'followup', '第二轮追问后仍在追问阶段');
    assert.equal(snap.session.followupUsed, 2, '追问计数达上限');

    const r3 = await service.skipFollowup(sid);
    assert.equal(r3.ok, true);
    await settleMicrotasks();
    snap = service.getToday();
    assert.equal(snap.session.phase, 'wrapup', '跳过后进入收束');
    assert.ok(snap.messages.some((m) => m.kind === 'skip-note'));

    const end = await service.endSession(sid);
    assert.equal(end.ok, true);
    await settleMicrotasks(200);

    snap = service.getToday();
    assert.equal(snap.session.status, 'closed');
    assert.ok(snap.latestReport, '应有正式日报');
    assert.equal(snap.latestReport.formal, true);
    assert.equal(snap.latestReport.rev, 1);
    assert.equal(snap.exportTask.status, 'done');
    assert.ok(snap.exportTask.targetRel.startsWith('日报/'));

    // 预算：5 次调用全部结算（chat×3 + refine + fix）
    const usageRows = all(db, `SELECT status, estimated FROM usage`);
    assert.equal(usageRows.length, 5);
    assert.ok(usageRows.every((u) => u.status === 'settled'));

    // 导出文件真实存在且含关键小节
    const vault = join(tmp, 'vault');
    const file = join(vault, '日报', `${snap.latestReport.date}.md`);
    assert.ok(existsSync(file), '导出文件应存在');
    const md = readFileSync(file, 'utf8');
    assert.ok(md.includes('修好了耳机'));
    assert.ok(md.includes('## 行动候选（未经确认，不视为已接受）'));
    assert.ok(md.includes('## 已确认的行动'));
    assert.ok(md.includes('prompt_version: "v1"'));
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('提炼两次校验失败：保留草稿、不产生正式日报、会话可重试', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  const responses = [
    () => sseResponse(['data: {"choices":[{"delta":{"content":"收到。"}}]}\n\ndata: [DONE]\n\n']),
    () => jsonChatResponse('坏 JSON {{'),
    () => jsonChatResponse('还是坏 JSON'),
  ];
  const { db, service } = makeService({ fetchCalls: [], responses, tmp });
  try {
    const start = service.startChat();
    const sid = start.snapshot.session.id;
    await service.send({ sessionId: sid, content: '今天很累，早点休息。' });
    const end = await service.endSession(sid);
    assert.equal(end.ok, false);
    await settleMicrotasks();
    const snap = service.getToday();
    assert.equal(snap.session.phase, 'refine_failed');
    assert.equal(snap.latestReport, null, '不虚报正式日报');
    const raw = get(db, `SELECT raw_response FROM model_requests WHERE kind='refine'`);
    assert.ok(raw && raw.raw_response && raw.raw_response.includes('坏 JSON'), '草稿原文保留');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('输入超过 24KiB：拒绝发送、不调用模型、消息仍落库', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  let fetchCount = 0;
  const { db, service } = makeService({
    fetchCalls: [],
    responses: [() => { fetchCount++; return sseResponse(['data: [DONE]\n\n']); }],
    tmp,
  });
  try {
    const start = service.startChat();
    const sid = start.snapshot.session.id;
    const big = '很长的故事'.repeat(3000); // ~36KB
    const r = await service.send({ sessionId: sid, content: big });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'input_limit');
    assert.equal(fetchCount, 0, '超限不得发起网络请求');
    const msgs = all(db, `SELECT * FROM messages WHERE session_id = ?`, sid);
    assert.equal(msgs.length, 1, '用户消息已先落库');
    const req = get(db, `SELECT error_class FROM model_requests WHERE session_id = ?`, sid);
    assert.equal(req.error_class, 'input_limit');
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('简短模式：不调用模型、直接生成正式日报并导出', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  let fetchCount = 0;
  const { service } = makeService({
    fetchCalls: [],
    responses: [() => { fetchCount++; return sseResponse(['data: [DONE]\n\n']); }],
    tmp,
  });
  try {
    const r = service.startShort({ content: '今天只做了一件事：把简历改完。', mood: '还行' });
    assert.equal(r.ok, true);
    await settleMicrotasks();
    assert.equal(fetchCount, 0, '简短模式不发起模型调用');
    const snap = service.getToday();
    assert.equal(snap.latestReport.formal, true);
    assert.equal(snap.exportTask.status, 'done');
    assert.ok(snap.latestReport.contentJson.includes('简历'));
    assert.ok(snap.latestReport.contentJson.includes('情绪标记：还行'));
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

test('导出：幂等重试、重名避让不覆盖、修订另存、路径越界拒绝', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er002-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    const vault = join(tmp, 'vault');
    settingsMod.setPlainSettings(db, { obsidianDir: vault });

    const content = { ...GOOD_REPORT, actions_accepted: [] };
    const date = '2026-10-01';
    const md = reportToMarkdown({ date, rev: 1, content, model: 'm', promptVersion: 'v1', appVersion: '0.1.0' });
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(Buffer.from(md, 'utf8')).digest('hex');

    // 人为插入任务（模拟提炼完成后的排程）
    const reportId = 'rep-1';
    const { run } = dist('db');
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES (?, ?, 1, 's1', ?, 'm', 'v1', 1, '2026-10-01T00:00:00Z')`, reportId, date, JSON.stringify(content));
    const taskId = dist('obsidian').createExportTask(db, { refId: reportId, targetRel: '日报/2026-10-01.md', contentHash: hash });

    // 冲突：目标已存在且内容不同 → 避让为 .知行2.md，原文件不动
    mkdirSync(join(vault, '日报'), { recursive: true });
    const conflict = join(vault, '日报', '2026-10-01.md');
    writeFileSync(conflict, '用户自己的旧笔记', 'utf8');
    const r1 = await runExportTask(db, taskId, '0.1.0');
    assert.equal(r1.ok, true);
    assert.ok(r1.targetRel.includes('.知行2.md'), `实际 ${r1.targetRel}`);
    assert.equal(readFileSync(conflict, 'utf8'), '用户自己的旧笔记', '绝不覆盖既有文件');
    const avoided = join(vault, ...r1.targetRel.split('/'));
    assert.ok(existsSync(avoided));

    // 幂等：同一任务再跑 → done 且不新增文件
    const r2 = await runExportTask(db, taskId, '0.1.0');
    assert.equal(r2.ok, true);
    assert.equal(r2.targetRel, r1.targetRel);

    // 修订另存：rev2 → 新文件 2026-10-01.r2.md
    const content2 = { ...content, keep_practices: ['新增一条'] };
    run(db, `UPDATE daily_reports SET content_json = ?, rev = 2 WHERE id = ?`, JSON.stringify(content2), reportId);
    const md2 = reportToMarkdown({ date, rev: 2, content: content2, model: 'm', promptVersion: 'v1', appVersion: '0.1.0' });
    const hash2 = createHash('sha256').update(Buffer.from(md2, 'utf8')).digest('hex');
    const taskId2 = dist('obsidian').createExportTask(db, { refId: reportId, targetRel: '日报/2026-10-01.r2.md', contentHash: hash2 });
    const r3 = await runExportTask(db, taskId2, '0.1.0');
    assert.equal(r3.ok, true);
    assert.ok(r3.targetRel.endsWith('.r2.md'));
    assert.ok(existsSync(join(vault, '日报', '2026-10-01.r2.md')));

    // 回读核验失败路径：篡改 vault 内容 hash 不可复现——直接测路径越界
    assert.equal(resolveVaultPath(vault, '../outside.md'), null);
    assert.equal(resolveVaultPath(vault, '日报/../../x.md'), null);
    assert.ok(resolveVaultPath(vault, '日报/2026-10-01.md'));
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// ER-003：思想库与小实验
// ---------------------------------------------------------------------------

const { seedPrinciples, listPrinciples, setCardEnabled, addDraftCard } = dist('principles');
const { createExperiment, addObservation, concludeExperiment, listExperiments, activeExperiment } = dist('experiments');
const RESOURCES_DIR = RESOURCES;

test('思想库种子：幂等入库、默认未启用、快照可溯源', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er003-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    const first = seedPrinciples(db, RESOURCES_DIR);
    assert.ok(first.inserted >= 8, `首批应入库 8 张，实际 ${first.inserted}`);
    const second = seedPrinciples(db, RESOURCES_DIR);
    assert.equal(second.inserted, 0, '重复种子不重复插入');
    assert.equal(second.skipped, first.inserted);
    const cards = listPrinciples(db);
    assert.ok(cards.every((c) => !c.enabled), '默认全部未启用（待用户确认）');
    assert.ok(cards.every((c) => c.snapshotId && c.sourceUrl), '首批卡必须带来源链接与快照');
    assert.ok(cards.some((c) => c.quoteOriginal.includes('say no to everything')));
    // 启用是显式动作
    setCardEnabled(db, cards[0].id, true);
    assert.equal(listPrinciples(db)[0].enabled, true);
    // 导入草稿：默认未启用
    const draft = addDraftCard(db, { text: '我自己的原则：先完成再完美', origin: 'suggestion' });
    assert.equal(draft.enabled, false);
    assert.equal(draft.snapshotId, null);
  } finally {
    try { db.close(); } catch {}
    rmTmp(tmp);
  }
});

test('小实验：约束（单进行中、周期≤7、三假设）与观察/结论闭环', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er003-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    const base = {
      hypotheses: ['睡够 7 小时写作更顺', '早起写作比晚上高效', '与睡眠无关，是咖啡的作用'],
      keyIndex: 0,
      action: '连续三天 22:30 上床',
      periodDays: 3,
      firstStep: '今晚把手机放客厅充电',
    };
    const r1 = createExperiment(db, base);
    assert.equal(r1.ok, true);
    assert.equal(r1.experiment.status, 'running');
    assert.equal(r1.experiment.hypotheses.length, 3);
    // 同时最多一个进行中
    const r2 = createExperiment(db, base);
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'active_exists');
    // 周期 >7 天拒绝（schema 层）
    assert.throws(() => {
      const { ExperimentCreateSchema } = require(join(ROOT, 'dist/shared/schemas.js'));
      ExperimentCreateSchema.parse({ ...base, periodDays: 9 });
    }, /too_big|≤|7/);
    // 观察
    assert.equal(addObservation(db, r1.experiment.id, '第一天：23:10 才睡，失败').ok, true);
    assert.equal(addObservation(db, r1.experiment.id, '').ok, false, '空观察拒绝');
    assert.equal(addObservation(db, 'no-such-id', 'x').ok, false);
    // 结论
    assert.equal(concludeExperiment(db, r1.experiment.id, { outcome: '三天里两天达标', conclusion: '写作节奏确有改善，继续保留早起写作' }).ok, true);
    assert.equal(addObservation(db, r1.experiment.id, '补记').ok, false, '结束后不能再补观察');
    assert.equal(concludeExperiment(db, r1.experiment.id, { outcome: 'x', conclusion: 'y' }).ok, false, '不能重复结束');
    const list = listExperiments(db);
    assert.equal(list[0].status, 'concluded');
    assert.equal(list[0].observations.length, 1);
    assert.equal(activeExperiment(db), null, '结束后无进行中实验');
    assert.equal(createExperiment(db, base).ok, true, '结束后可再创建');
  } finally {
    try { db.close(); } catch {}
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// ER-004：周期报告与提醒
// ---------------------------------------------------------------------------

const periodic = dist('periodic');
const reminders = dist('reminders');

test('周期计算：周一至周日、已完成周期不含当期', () => {
  // 2026-10-01 是周四：所在周为 2026-09-28（一）~ 10-04（日），尚未结束
  const thursday = new Date(2026, 9, 1);
  const cur = periodic.weekContaining(thursday);
  assert.equal(cur.start, '2026-09-28');
  assert.equal(cur.end, '2026-10-04');
  const done = periodic.completedPeriods(thursday, { weekly: 2, monthly: 2, yearly: 1 });
  const weeks = done.filter((p) => p.kind === 'weekly');
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].start, '2026-09-21');
  assert.equal(weeks[0].end, '2026-09-27');
  const months = done.filter((p) => p.kind === 'monthly');
  assert.equal(months[0].start, '2026-09-01');
  assert.equal(months[0].end, '2026-09-30');
  assert.ok(!done.some((p) => p.end >= '2026-10-01'), '未结束的周期不应出现');
});

test('周期报告生成（mock）：绑定日报索引、空周期跳过、日报更新后标记过时并重生成 v2', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er004-'));
  try {
    mkdirSync(join(tmp, 'vault'), { recursive: true }); // R3：导出目录必须真实存在
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault'), budgetMonthlyCny: 20, priceInCnyPerMtok: 8, priceOutCnyPerMtok: 8 });
    // B4：分批后请求数不再固定（批 + 汇总）——用无限供应，按调用次序变化内容
    let call = 0;
    const responses = new Proxy({}, {
      get() {
        call++;
        return () => jsonChatResponse(JSON.stringify({
          coverage: '覆盖统计',
          highlights: call % 2 === 1 ? ['修而不换'] : ['修而不换', '保护套防折损'],
          patterns: call > 2 ? ['动手解决问题'] : [],
          open_questions: call % 2 === 1 ? ['早起写作是否成立'] : [],
        }));
      },
    });
    const events = [];
    const period = periodic.createPeriodService({
      db, promptsBaseDir: RESOURCES_DIR, appVersion: '0.1.0',
      getApiKey: () => 'dummy-key',
      fetchFn: async () => { const n = responses.whatever; return n(); },
      notifyApp: (e) => events.push(e),
    });
    // 空周期不生成
    const emptyP = { kind: 'weekly', start: '2026-09-21', end: '2026-09-27', label: '周报 2026-W39' };
    const rEmpty = await period.generate(emptyP);
    assert.equal(rEmpty.ok, false);
    assert.equal(rEmpty.error, 'empty');
    // 造两份正式日报（周五、周六）
    const { run } = dist('db');
    const ins = (id, date) => run(db,
      `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
       VALUES (?, ?, 1, 's', ?, 'glm-5.3-flash', 'v1', 1, ?)`,
      id, date, JSON.stringify({ ...GOOD_REPORT }), new Date().toISOString());
    ins('d1', '2026-09-25');
    ins('d2', '2026-09-26');
    const r1 = await period.generate(emptyP);
    assert.equal(r1.ok, true, r1.ok ? '' : r1.detail);
    assert.equal(r1.report.bindings.daily_report_ids.length, 2, '证据索引绑定两份日报');
    assert.equal(r1.report.bindings.prompt_version, 'v1');
    assert.equal(r1.report.stale, false);
    await new Promise((r) => setTimeout(r, 300));
    // 导出文件在 周报/ 目录
    const weekFile = join(tmp, 'vault', '周报');
    assert.ok(existsSync(weekFile));
    // 日报修订更新 → 报告过时
    run(db, `UPDATE daily_reports SET superseded_by = 'd1-new' WHERE id = 'd1'`);
    const listed = periodic.listPeriodReports(db);
    assert.equal(listed[0].stale, true, '绑定的日报被替代后应标记过时');
    // 重新生成 → 新修订，保留旧版
    const r2 = await period.generate(emptyP);
    assert.equal(r2.ok, true);
    assert.equal(r2.report.bindings.rev, 2);
    assert.equal(periodic.listPeriodReports(db).length, 2, '旧版本保留');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(existsSync(join(tmp, 'vault', '周报', '2026-09-21_2026-09-27.r2.md')), 'r2 文件另存');
    // 预算：两次生成全部结算
    const usage = all(db, `SELECT status FROM usage`);
    assert.ok(usage.every((u) => u.status === 'settled'));
  } finally {
    try { db.close(); } catch {}
    rmTmp(tmp);
  }
});

test('周期报告 JSON 校验：宽容数组缺省、拒绝坏结构', () => {
  const ok = periodic.parsePeriodReportJson('```json {"coverage":"c","highlights":["a"],"patterns":[],"open_questions":[]}```');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.content.highlights, ['a']);
  const bad = periodic.parsePeriodReportJson('{"highlights":"不是数组"}');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('coverage')));
});

test('提醒决策：窗口外不打扰、一天一次、已记录不打扰、先落记录再通知', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er004-'));
  try {
    const db = openDb(join(tmp, 'a.db'));
    settingsMod.setPlainSettings(db, { obsidianDir: join(tmp, 'vault') });
    const cfg = { enabled: true, start: '21:30', end: '23:00' };
    const inWindow = new Date(2026, 9, 1, 22, 0);
    const outside = new Date(2026, 9, 1, 20, 0);
    // 窗口外
    assert.deepEqual(reminders.decideReminder(db, outside, cfg), { action: 'none', reason: 'outside_window' });
    // 窗口内 + 无记录 + 无日报 → 提醒
    assert.deepEqual(reminders.decideReminder(db, inWindow, cfg), { action: 'notify' });
    // 先落记录，再"弹通知"——第二次决策不再提醒（去重）
    reminders.recordAttempt(db, inWindow, 'notification');
    assert.equal(reminders.hasAttempted(db, '2026-10-01'), true);
    assert.deepEqual(reminders.decideReminder(db, inWindow, cfg), { action: 'none', reason: 'already_attempted' });
    // 禁用
    assert.deepEqual(reminders.decideReminder(db, inWindow, { ...cfg, enabled: false }), { action: 'none', reason: 'disabled' });
    // 已有正式日报 → 即便跨天也不打扰（以当天判断）
    const { run } = dist('db');
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, model, prompt_version, formal, created_at)
             VALUES ('d9', '2026-10-02', 1, 's', '{}', NULL, NULL, 1, '2026-10-02T12:00:00Z')`);
    const day2 = new Date(2026, 9, 2, 22, 0);
    assert.deepEqual(reminders.decideReminder(db, day2, cfg), { action: 'none', reason: 'already_reflected' });
  } finally {
    try { db.close(); } catch {}
    rmTmp(tmp);
  }
});

// ---------------------------------------------------------------------------
// ER-005：备份与恢复
// ---------------------------------------------------------------------------

const backupMod = dist('backup');

test('备份与恢复：VACUUM 快照、结构校验、恢复标记与启动生效（原库留档）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'er005-'));
  const userData = join(tmp, 'userdata');
  try {
    const db = openDb(join(userData, 'zhixing.db'));
    // 放一点数据
    const { run } = dist('db');
    run(db, `INSERT INTO daily_reports (id, date, rev, source_session_id, content_json, formal, created_at)
             VALUES ('bx', '2026-10-01', 1, 's', '{}', 1, ?)`, new Date().toISOString());
    // 备份
    const outDir = join(tmp, 'backups');
    mkdirSync(outDir, { recursive: true });
    const r = backupMod.backupDatabase(db, outDir, userData);
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(r.file));
    assert.ok(existsSync(r.file + '.meta.json'));
    // 校验备份文件
    const check = backupMod.validateRestoreSource(r.file);
    assert.equal(check.ok, true, check.error);
    assert.ok((check.counts?.['日报'] ?? 0) >= 1);
    // 非本应用的文件被拒绝（原生 sqlite，不带应用表结构）
    const { DatabaseSync } = require('node:sqlite');
    const junk = join(tmp, 'junk.db');
    const junkDb = new DatabaseSync(junk);
    junkDb.exec('CREATE TABLE t (x INTEGER)');
    junkDb.close();
    assert.equal(backupMod.validateRestoreSource(junk).ok, false);
    // 请求恢复 → 标记写入；启动时应用：原库留档
    const req = backupMod.requestRestore(userData, r.file);
    assert.equal(req.ok, true);
    db.close(); // Windows：替换被打开的库文件前必须先释放句柄
    const applied = backupMod.applyPendingRestore(userData);
    assert.equal(applied.restored, true);
    assert.ok(existsSync(join(userData, 'zhixing.db.before-restore')), '当前数据已留档');
    const reopened = openDb(join(userData, 'zhixing.db'));
    const n = (reopened.prepare(`SELECT COUNT(*) AS n FROM daily_reports`).get()).n;
    assert.ok(n >= 1, '恢复后的库包含备份数据');
    reopened.close();
    // 幂等：无标记时不再动作
    assert.equal(backupMod.applyPendingRestore(userData).restored, false);
  } finally {
    try { db.close(); } catch {}
    rmTmp(tmp);
  }
});
