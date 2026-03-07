import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';
import solid from 'vite-plugin-solid';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'content-script': resolve(__dirname, 'src/preload/content-script.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [solid()],
    build: {
      rollupOptions: {
        input: './src/renderer/index.html',
      },
    },
  },
});
