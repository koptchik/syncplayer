import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node src/server/index.mjs',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: '3100',
      DATA_DIR: `.data/e2e-${Date.now()}-${process.pid}`,
      PUBLIC_ORIGIN: 'https://stream.koptchik.duckdns.org',
    },
  },
});
