// MCP add_quick_note 探针：定位快照中 exportTask 缺失问题（调试用，不属于测试基线）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'probe-'));
const dbPath = join(tmp, 'zhixing.db');

const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], {
  env: { ...process.env, ZHIXING_DB_PATH: dbPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));
let buf = '';
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log('UNPARSEABLE:', line.slice(0, 150)); continue; }
    if (m.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_quick_note', arguments: { content: 'probe' } } });
    } else if (m.id === 2) {
      if (m.error) {
        console.log('RPC-ERROR', JSON.stringify(m.error));
      } else {
        const t = JSON.parse(m.result.content[0].text);
        console.log('ok:', t.ok);
        console.log('latestReport:', JSON.stringify(t.snapshot?.latestReport ?? null).slice(0, 400));
        console.log('exportTask:', JSON.stringify(t.snapshot?.exportTask ?? null).slice(0, 200));
        console.log('messages:', t.snapshot?.messages?.length);
      }
      child.kill();
      process.exit(0);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } } });
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 15000);
void rmSync; void tmp;
