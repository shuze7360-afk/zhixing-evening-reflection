// 开发编排：构建主/预加载进程 → 启动 Vite 渲染服务 → 等端口就绪 → 启动 Electron。
// 全部直接调用可执行文件（不经 shell），保证退出时能真正结束子进程。
// 任一子进程退出则整体退出；视觉截图模式经环境变量传给主进程（src/main/index.ts）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const VITE = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const ELECTRON = resolve(ROOT, 'node_modules/electron/dist/electron.exe');

for (const bin of [TSC, VITE, ELECTRON]) {
  if (!existsSync(bin)) {
    console.error(`[dev] 缺少可执行文件: ${bin}（先运行 npm install）`);
    process.exit(1);
  }
}

function fail(step, result) {
  console.error(`[dev] ${step} 失败（exit=${result.status}）`);
  process.exit(result.status ?? 1);
}

const tsc = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.json'], {
  cwd: ROOT, stdio: 'inherit',
});
if (tsc.status !== 0) fail('tsc 主进程构建', tsc);

const preload = spawnSync(process.execPath, [resolve(ROOT, 'scripts/build-preload.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (preload.status !== 0) fail('esbuild 预加载打包', preload);

// 端口被占用时直接报错退出（strictPort 由 Vite 兜底），避免误连旧服务
const busy = await fetch('http://localhost:5173/').then(
  () => true,
  () => false,
);
if (busy) {
  console.error('[dev] 端口 5173 已被占用：先结束残留的 Vite 进程再运行 npm run dev');
  process.exit(1);
}

const vite = spawn(process.execPath, [VITE, '--port', '5173', '--strictPort'], {
  cwd: ROOT, stdio: 'inherit',
});
// 就绪检测不解析输出（Vite 输出含 ANSI 色码），直接轮询端口
const viteReady = (async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:5173/');
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Vite 启动超时（30s）');
})();
try {
  await viteReady;
} catch (err) {
  console.error('[dev]', err.message);
  vite.kill();
  process.exit(1);
}

const electron = spawn(ELECTRON, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173/' },
});

electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
vite.on('exit', () => {
  electron.kill();
  process.exit(0);
});
process.on('SIGINT', () => {
  vite.kill();
  electron.kill();
  process.exit(0);
});
