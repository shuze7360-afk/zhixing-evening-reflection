// 生成应用托盘图标（32×32 青绿圆角方块）。构建期一次性运行：node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const W = 32;
const H = 32;

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 圆角方块：边缘 3px 透明，内部青绿 #176b75，中心稍亮
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const margin = 3;
    const inside = x >= margin && x < W - margin && y >= margin && y < H - margin;
    const corner =
      (x < margin + 4 || x >= W - margin - 4) && (y < margin + 4 || y >= H - margin - 4);
    const dx = x < W / 2 ? margin + 4 - x : x - (W - margin - 5);
    const dy = y < H / 2 ? margin + 4 - y : y - (H - margin - 5);
    const rounded = corner && dx + dy > 5;
    const o = y * (1 + W * 4) + 1 + x * 4;
    if (inside && !rounded) {
      raw[o] = 23;
      raw[o + 1] = 107;
      raw[o + 2] = 117;
      raw[o + 3] = 255;
    }
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(dirname(import.meta.filename), '../resources/icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`[make-icon] ${out} (${png.length} bytes)`);
