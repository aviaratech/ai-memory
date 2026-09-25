import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.integration.test.ts'],
    maxWorkers: 1,
  },
});
