import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';

const rendererRoot = resolve(dirname(import.meta.filename), 'src/renderer');

export default defineConfig({
  root: rendererRoot,
  base: './', // file:// 加载需要相对资源路径（打包版）
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(dirname(import.meta.filename), 'dist/renderer'),
    emptyOutDir: true,
  },
});
