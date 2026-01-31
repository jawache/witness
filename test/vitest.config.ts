import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests from the test directory
    root: './test',
    // Integration tests may take time
    testTimeout: 30000,
    // Run tests sequentially since they share server state
    sequence: {
      concurrent: false,
    },
    // Include integration tests
    include: ['integration/**/*.test.ts'],
  },
});
