import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/');
  await page.locator('#settings-open').click(); await page.locator('#simli-settings').scrollIntoViewIfNeeded();
  const publicConfig = await page.evaluate(async () => (await fetch('/api/config')).json());
  const result = {
    checkedAt: new Date().toISOString(),
    doubaoConfigured: publicConfig.doubao?.configured === true,
    simliCredentialConfigured: publicConfig.simli?.credentialConfigured === true,
    simliPortraitConfigured: publicConfig.simli?.configured === true,
    videoEnabled: publicConfig.simli?.enabled === true,
    keyFieldEmpty: await page.locator('#simli-api-key').inputValue() === '',
    subtitlesHidden: await page.locator('#subtitle').isHidden(),
    videoHiddenBeforeConnection: await page.locator('#live-avatar-video').isHidden(),
    pageErrors: errors,
  };
  await page.locator('#simli-settings').screenshot({ path: 'output/simli-setup-ready.png' });
  await writeFile('output/simli-setup-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.doubaoConfigured || !result.simliCredentialConfigured || !result.keyFieldEmpty || !result.subtitlesHidden || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
