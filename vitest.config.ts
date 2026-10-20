import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/backend/tests/**/*.test.ts'],
    environment: 'node',
    // 集成测试需要 Docker + pgvector；没有 Docker 时自动跳过，单元测试照常跑
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
