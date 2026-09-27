// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 4173;

module.exports = defineConfig({
  testDir: './specs',
  timeout: 90000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Keep tests independent of network access to Google Fonts
    serviceWorkers: 'block'
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 1000 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ }
  ],
  webServer: {
    command: `node serve.js`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI
  }
});
