// Tests de bout en bout Playwright pilotant la vraie application Electron.
// Lancement : npm run test:e2e   (rapport HTML : outputs/playwright-report)
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.cjs',
  timeout: 180000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'outputs/playwright-results',
  reporter: [['list'], ['html', { outputFolder: 'outputs/playwright-report', open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
