// 共享工具：状态源读写、内容哈希、交付范围收集。
// handoff-check / render-state / freeze-candidate 三个脚本共用，保证哈希算法一致。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATE_FILE = 'project-state.json';

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function loadState() {
  const raw = readFileSync(join(ROOT, STATE_FILE), 'utf8');
  return JSON.parse(raw);
}

export function normalizeState(state) {
  return JSON.stringify(state, null, 2);
}

// 生成文件标记用的状态哈希：对规范化 JSON 计算，两侧算法一致
export function stateHash(state) {
  return sha256Hex(Buffer.from(normalizeState(state), 'utf8')).slice(0, 12);
}

export function saveState(state) {
  state.updated_at = new Date().toISOString();
  writeFileSync(join(ROOT, STATE_FILE), normalizeState(state) + '\n', 'utf8');
}

export function isFilePath(p) {
  return /\.[A-Za-z0-9]+$/.test(p);
}

export function listFilesRel(baseRel) {
  const baseAbs = join(ROOT, baseRel);
  if (!existsSync(baseAbs)) throw new Error(`范围路径不存在: ${baseRel}`);
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.push({ abs, rel: relative(ROOT, abs).replace(/\\/g, '/') });
    }
  })(baseAbs);
  return out;
}

// 交付范围约定：带扩展名的条目视为文件，否则视为目录递归收集；结果按相对路径排序去重
export function collectScope(scope) {
  const seen = new Set();
  const out = [];
  for (const entry of scope) {
    const items = isFilePath(entry)
      ? [{ abs: join(ROOT, entry), rel: entry.replaceAll('\\', '/') }]
      : listFilesRel(entry);
    for (const item of items) {
      if (seen.has(item.rel)) continue;
      if (!existsSync(item.abs)) throw new Error(`范围路径不存在: ${item.rel}`);
      seen.add(item.rel);
      out.push(item);
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// 候选哈希：对排序后的文件列表依次混入「相对路径 \n 字节数 \n 单文件 sha256 \n」
export function hashCandidate(entries) {
  const h = createHash('sha256');
  for (const e of entries) {
    const buf = readFileSync(e.abs);
    h.update(e.rel + '\n');
    h.update(String(buf.length) + '\n');
    h.update(sha256Hex(buf) + '\n');
  }
  return 'sha256:' + h.digest('hex');
}

export function gitInfo() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const st = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dirty = st.split('\n').filter((l) => l.trim().length > 0).length;
    return { head, dirty };
  } catch {
    return { head: null, dirty: null };
  }
}

export function readTextIfExists(relPath) {
  const p = join(ROOT, relPath);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
