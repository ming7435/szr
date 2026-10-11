import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 40000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1100 }, permissions: ['microphone'], launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4173/api/config', reuseExistingServer: true }
});
