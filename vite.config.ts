import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      outDir: 'dist',
      include: ['src'],
      entryRoot: 'src',
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rolldownOptions: {
      external: [/^@modelcontextprotocol\//, 'zod', 'zod/v4', /^node:/],
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
