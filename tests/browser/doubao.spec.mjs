import { test, expect } from '@playwright/test';

const configuration = configured => ({ apiConfigured: false, localVoice: { available: true }, chatgpt: { sharing: true }, doubao: { selected: true, configured, voice: 'uploaded-reference' } });
const pcm = Buffer.alloc(48000);
for (let n = 0; n < 24000; n++) pcm.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 330 / 24000) * 5000), n * 2);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.doubaoMicrophone = stream; return stream; };
  });
});

test('pending Doubao setup opens private settings, prevents fallback and saves no browser token', async ({ page }) => {
  let configured = false, payload;
  await page.route('/api/config', route => route.fulfill({ json: configuration(configured) }));
  await page.route('/api/doubao/settings', route => { payload = route.request().postDataJSON(); configured = true; return route.fulfill({ json: configuration(true).doubao }); });
  await page.goto('/'); await expect(page.locator('#connection-summary')).toHaveText('语音服务待配置');
  await page.locator('#connect').click(); await expect(page.locator('#settings')).toBeVisible();
  expect(await page.evaluate(() => !!window.doubaoMicrophone)).toBe(false);
  await expect(page.locator('.chatgpt-card')).toBeHidden();
  await page.locator('#doubao-api-key').fill('test-private-api-key');
  await page.locator('#doubao-voice-id').fill('S_my_uploaded_voice');
  await page.locator('#doubao-own-voice').check(); await page.locator('#doubao-save').click();
  await expect(page.locator('#doubao-api-key')).toHaveValue('');
  await expect(page.locator('#connection-summary')).toHaveText('可以开始验证');
  expect(payload.ownVoiceConfirmed).toBe(true);
  expect(payload.authMode).toBe('api-key');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-private-api-key');
});

test('native PCM streams before answer completes, stop rejects queued audio and microphone is released', async ({ page }) => {
  let socket, inputFrames = 0, interrupted = 0;
  await page.route('/api/config', route => route.fulfill({ json: configuration(true) }));
  await page.routeWebSocket('**/api/doubao/live', ws => {
    socket = ws;
    ws.onMessage(message => {
      if (Buffer.isBuffer(message)) { expect(message.length).toBe(1024); inputFrames++; return; }
      const event = JSON.parse(message);
      if (event.type === 'start') ws.send(JSON.stringify({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 }));
      if (event.type === 'interrupt') interrupted++;
    });
  });
  await page.goto('/'); await page.locator('#connect').click();
  await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  await expect.poll(() => inputFrames).toBeGreaterThan(0);
  await page.locator('#mute').click();
  expect(await page.evaluate(() => window.doubaoMicrophone.getAudioTracks()[0].enabled)).toBe(false);
  socket.send(JSON.stringify({ type: 'response_started', replyId: 'first', questionId: 'q1' }));
  // Legal faster-than-real-time delivery must not disconnect an eight-second answer.
  for (let n = 0; n < 8; n++) socket.send(pcm);
  await expect.poll(() => page.locator('#remote-audio').evaluate(audio => !audio.paused && audio.currentTime > .1)).toBe(true);
  await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接');
  await expect(page.locator('#subtitle')).toBeHidden(); await expect(page.locator('#chat')).toBeHidden();
  await page.locator('#interrupt').click(); await expect.poll(() => interrupted).toBe(1);
  expect(await page.locator('#remote-audio').evaluate(audio => audio.paused)).toBe(true);
  socket.send(pcm); await page.waitForTimeout(150);
  expect(await page.locator('#remote-audio').evaluate(audio => audio.paused)).toBe(true);
  socket.send(JSON.stringify({ type: 'speech_started' }));
  socket.send(JSON.stringify({ type: 'response_started', replyId: 'second' })); socket.send(pcm);
  await expect.poll(() => page.locator('#remote-audio').evaluate(audio => !audio.paused)).toBe(true);
  await page.locator('#connect').click();
  expect(await page.evaluate(() => window.doubaoMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  expect(await page.locator('#remote-audio').evaluate(audio => audio.srcObject)).toBe(null);
});

test('cancelled handshake cannot start the microphone or play delayed audio', async ({ page }) => {
  let socket;
  await page.route('/api/config', route => route.fulfill({ json: configuration(true) }));
  await page.routeWebSocket('**/api/doubao/live', ws => { socket = ws; ws.onMessage(() => {}); });
  await page.goto('/'); await page.locator('#connect').click();
  await expect(page.locator('#connect')).toContainText('取消连接');
  await page.locator('#connect').click();
  try { socket.send(JSON.stringify({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 })); } catch {}
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => !!window.doubaoMicrophone)).toBe(false);
  await expect(page.locator('#connect')).toContainText('开始对话');
});
