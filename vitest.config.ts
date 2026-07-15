import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      thresholds: {
        statements: 60,
        branches: 70,
        functions: 75,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@skyloom': path.resolve(__dirname, 'src'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
