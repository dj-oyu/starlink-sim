import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tleSync from './server/vite-plugin-tle.mjs';

export default defineConfig({
  // GitHub Pages serves under /<repo>/: the workflow sets BASE_PATH (.github/workflows/pages.yml)
  base: process.env.BASE_PATH || '/',
  define: { __BUILD_ID__: JSON.stringify((process.env.GITHUB_SHA || 'dev').slice(0, 7)) },
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
  server: {
    port: 5173,
  },
});
