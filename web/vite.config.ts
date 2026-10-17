import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
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
  server: {
    port: 5173,
  },
});
