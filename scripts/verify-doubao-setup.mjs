// Read-only local readiness probe; does not connect to the cloud or open microphone.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.getElementById('connection-summary').textContent === '豆包语音待配置');
  const config = await (await page.request.get('http://127.0.0.1:4173/api/config')).json();
  assert.equal(config.doubao.selected, true); assert.equal(config.doubao.configured, false);
  assert.equal(Object.hasOwn(config.doubao, 'apiKey'), false); assert.equal(Object.hasOwn(config.doubao, 'accessToken'), false);
  await page.locator('#connect').click();
  assert.equal(await page.locator('#settings').isVisible(), true);
  assert.equal(await page.locator('#doubao-api-key').isVisible(), true);
  assert.equal(await page.locator('#doubao-app-id').isVisible(), false);
  assert.equal(await page.locator('#subtitle').isVisible(), false);
  assert.equal(await page.locator('#text-form').isVisible(), false);
  await page.screenshot({ path: 'output/doubao-settings-ready.png', fullPage: true });
  const record = { at: new Date().toISOString(), selected: 'doubao', configured: false, cloudDialogueVerified: false, portraitChanged: false, privateCredentialFieldsAbsent: true, defaultAuthentication: 'api-key', voiceOnly: true, errors };
  assert.deepEqual(errors, []);
  await writeFile('output/doubao-setup-verification.json', JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
} finally { await browser.close(); }
