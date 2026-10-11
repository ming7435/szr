import { test, expect } from '@playwright/test';

test('voice interface hides text composition, transcripts and captions while retaining audio controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#text-form')).toBeHidden();
  await expect(page.locator('#chat')).toBeHidden();
  await expect(page.locator('#subtitle')).toBeHidden();
  await expect(page.locator('.chatgpt-card')).toBeHidden();
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('.voice-strip')).toHaveCount(0);
  await expect(page.locator('#preview-reference')).toHaveCount(0);
  await page.screenshot({ path: 'output/voice-only.png', fullPage: true });
});
