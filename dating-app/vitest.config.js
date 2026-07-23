import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VITEST: 'true',
      NODE_ENV: 'development',
    },
  },
});
