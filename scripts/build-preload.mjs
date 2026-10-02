// 预加载脚本打包：sandbox 模式下 preload 不能 require 相对模块，必须打成单文件。
// shared/ipc.ts 仍为通道白名单唯一来源，此处仅负责打包产物。
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';

await build({
  entryPoints: [resolve(dirname(import.meta.filename), '../src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: resolve(dirname(import.meta.filename), '../dist/preload/index.js'),
  sourcemap: false,
  logLevel: 'silent',
});
console.log('[build-preload] dist/preload/index.js');
