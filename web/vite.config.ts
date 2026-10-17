import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';
import tleSync from './server/vite-plugin-tle.mjs';

export default defineConfig({
  plugins: [preact(), tleSync()],
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    rollupOptions: {
      // the main app plus the standalone on-device diagnostic page (/stall.html)
      input: {
        main: resolve(__dirname, 'index.html'),
        stall: resolve(__dirname, 'stall.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});
