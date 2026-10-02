// ER-M01 MCP 协议冒烟测试：spawn mcp/server.mjs，走 stdio JSON-RPC：
// initialize → tools/list → tools/call（add_quick_note / get_report / create_experiment / get_budget_status）。
// 使用 ZHIXING_DB_PATH 指向临时库，不触碰真实数据。运行：node --test tests/mcp-smoke.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');

function startServer(dbPath) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, ZHIXING_DB_PATH: dbPath, ZHIXING_OBSIDIAN_DIR: join(dbPath, '..', 'vault') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    }
  });
  child.stderr.on('data', () => undefined); // 运行信息不参与断言
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`请求超时: ${method}`));
        }
      }, 15000);
    });
  const stop = async () => {
    child.kill();
    await new Promise((res) => {
      const t = setTimeout(res, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        res();
      });
    });
  };
  return { child, request, stop };
}

test('MCP 服务器：握手、工具清单、核心工具调用', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mcp-'));
  const dbPath = join(tmp, 'zhixing.db');
  mkdirSync(join(dbPath, '..', 'vault'), { recursive: true }); // R3：导出目录必须真实存在
  const { child, request, stop } = startServer(dbPath);
  try {
    // 1. initialize 握手
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'zhixing-smoke', version: '0.0.1' },
    });
    assert.equal(init.serverInfo.name, 'zhixing');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    // 2. tools/list
    const tools = await request('tools/list', {});
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      'today_snapshot', 'add_quick_note', 'get_report', 'list_reports', 'export_report',
      'list_principles', 'add_principle_draft', 'list_experiments', 'create_experiment',
      'add_observation', 'conclude_experiment', 'list_period_reports', 'get_budget_status',
    ]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }

    // 3. add_quick_note：写一句话 → 正式日报 + 导出
    const note = await request('tools/call', {
      name: 'add_quick_note',
      arguments: { content: 'MCP 冒烟：今天把 MCP 服务器写完了。', mood: '还行' },
    });
    const noteData = JSON.parse(note.content[0].text);
    assert.equal(noteData.ok, true);
    assert.equal(noteData.snapshot.latestReport.formal, true);
    assert.equal(noteData.snapshot.exportTask.status, 'done',
      'snapshot=' + JSON.stringify(noteData.snapshot).slice(0, 400));
    assert.ok(existsSync(dbPath), '临时库已建立');

    // 4. get_report：能读回刚写的日报
    const rep = await request('tools/call', { name: 'get_report', arguments: {} });
    const repData = JSON.parse(rep.content[0].text);
    assert.equal(repData.ok, true);
    assert.ok(repData.reports.length >= 1);
    assert.ok(JSON.stringify(repData.reports[0]).includes('MCP 冒烟'));

    // 5. create_experiment（R10：MCP 创建草稿，不占用单进行中；启动须在应用确认）
    const expArgs = {
      hypotheses: ['A 假设', 'B 假设', 'C 假设'],
      keyIndex: 0,
      action: '连续三天记录 MCP 使用体感',
      periodDays: 3,
      firstStep: '明天开一次 ZCode 会话走一遍 MCP 工具',
    };
    const exp = await request('tools/call', { name: 'create_experiment', arguments: expArgs });
    const expData = JSON.parse(exp.content[0].text);
    assert.equal(expData.ok, true);
    assert.equal(expData.experiment.status, 'planned', 'MCP 创建的必须是草稿');
    assert.ok(String(expData.note ?? '').includes('应用'), '返回值必须提示到应用中确认');
    // 草稿不冲突：第二个也能建
    const exp2 = await request('tools/call', { name: 'create_experiment', arguments: expArgs });
    assert.equal(JSON.parse(exp2.content[0].text).ok, true, '草稿之间不冲突');
    // R10 语义：草稿不能被观察/结论（还没开始）
    const obsDraft = await request('tools/call', {
      name: 'add_observation',
      arguments: { id: expData.experiment.id, text: '第一天：工具响应正常' },
    });
    assert.equal(JSON.parse(obsDraft.content[0].text).ok, false, '草稿不可记录观察');
    // 危险输入被拒：超过 7 天
    const tooLong = await request('tools/call', {
      name: 'create_experiment',
      arguments: { ...expArgs, periodDays: 9 },
    });
    const tooText = tooLong.content[0].text;
    const rejected = (() => {
      try { return JSON.parse(tooText).ok !== true; } catch { return true; }
    })();
    assert.ok(rejected, '超过 7 天的实验必须被拒绝');

    // 6. get_budget_status：无密钥泄漏
    const budget = await request('tools/call', { name: 'get_budget_status', arguments: {} });
    const budgetText = budget.content[0].text;
    assert.ok(!budgetText.includes('apiKeyEnc'), '不得出现密钥字段');

    // 7. 危险输入被拒：超过 7 天的实验
        const listAfter = await request('tools/call', { name: 'list_experiments', arguments: {} });
    const expsAfter = JSON.parse(listAfter.content[0].text).experiments;
    assert.equal(expsAfter.filter((e) => e.status === 'running').length, 0, 'MCP 不启动任何实验');
    assert.ok(expsAfter.filter((e) => e.status === 'planned').length >= 2, '两个草稿都在');
  } finally {
    await stop();
    for (let i = 0; i < 8; i++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  }
});
