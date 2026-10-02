// 生成应用图标 resources/icon.ico（多尺寸：16/32/48 BMP + 256 PNG 条目）。
// 知行视觉：暖白纸面圆角方块 + 青绿底 + "知"字意象的横杠标记（与 UI_SPEC 色板一致）。
// 运行：node scripts/make-ico.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 渲染函数：size×size RGBA。青绿圆角方块 + 白色"知"意象（上横杠 + 人字撇捺简化为竖点）。 */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  };
  const radius = Math.max(2, Math.round(size * 0.22));
  const m = Math.max(1, Math.round(size * 0.06));
  // 圆角矩形（青绿 #176b75；深浅主题各自可读，取品牌主色）
  const inside = (x, y) => {
    if (x < m || y < m || x >= size - m || y >= size - m) return false;
    const cx = Math.min(x - m, size - m - 1 - x);
    const cy = Math.min(y - m, size - m - 1 - y);
    if (cx >= radius || cy >= radius) return true;
    const dx = radius - cx, dy = radius - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inside(x, y)) set(x, y, 23, 107, 117);
    }
  }
  // 白色标记：上横杠 + 下部开口框（"知"的矢部意象），线宽按比例
  const lw = Math.max(1, Math.round(size * 0.09));
  const fg = (x, y) => {
    if (!inside(x, y)) return false;
    const pad = Math.round(size * 0.2);
    const x0 = pad, x1 = size - pad, y0 = pad, y1 = size - pad;
    // 上横杠
    if (y >= y0 && y < y0 + lw && x >= x0 && x < x1) return true;
    // 左竖 + 右下钩（开口矩形）
    if (x >= x0 && x < x0 + lw && y >= y0 && y < y1) return true;
    if (x >= x1 - lw && x < x1 && y >= y0 + Math.round((y1 - y0) * 0.45) && y < y1) return true;
    if (y >= y1 - lw && y < y1 && x >= x0 && x < x1) return true;
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (fg(x, y)) set(x, y, 250, 249, 246);
    }
  }
  return Buffer.from(px);
}

function bmpEntry(size) {
  const px = render(size);
  // BGRA + 行序自底向上
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = px[src + 2];
      xor[dst + 1] = px[src + 1];
      xor[dst + 2] = px[src];
      xor[dst + 3] = px[src + 3];
    }
  }
  const andMaskSize = size * 4 * size; // 1bpp，每行 4 字节对齐（32px 宽）
  const and = Buffer.alloc(andMaskSize);
  const h = Buffer.alloc(40);
  h.writeUInt32LE(40, 0);
  h.writeInt32LE(size, 4);
  h.writeInt32LE(size * 2, 8);
  h.writeUInt16LE(1, 12);
  h.writeUInt16LE(32, 14);
  h.writeUInt32LE(0, 16);
  h.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([h, xor, and]);
}

function pngEntry(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    px.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const entries = [
  { size: 16, data: bmpEntry(16) },
  { size: 32, data: bmpEntry(32) },
  { size: 48, data: bmpEntry(48) },
  { size: 64, data: bmpEntry(64) },
  { size: 256, data: pngEntry(256) },
];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const dirs = [];
let offset = 6 + entries.length * 16;
for (const e of entries) {
  const d = Buffer.alloc(16);
  d[0] = e.size === 256 ? 0 : e.size;
  d[1] = e.size === 256 ? 0 : e.size;
  d.writeUInt16LE(1, 4);
  d.writeUInt16LE(32, 6);
  d.writeUInt32LE(e.data.length, 8);
  d.writeUInt32LE(offset, 12);
  offset += e.data.length;
  dirs.push(d);
}
const ico = Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
const out = resolve(dirname(import.meta.filename), '../resources/icon.ico');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ico);
console.log(`[make-ico] ${out} (${ico.length} bytes, sizes ${entries.map((e) => e.size).join('/')})`);
