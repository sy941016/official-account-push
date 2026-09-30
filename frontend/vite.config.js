import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

/**
 * 前端工程配置。
 * - root: 本文件所在目录(frontend/),源码在 frontend/src
 * - 生产构建产物输出到 src/server/public/dist,由 Node 直接伺服
 * - dev 模式由 Vite 起 5173 端口,把 /api、/health 代理到后端 3000 端口,避免跨域
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../src/server/public/dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
