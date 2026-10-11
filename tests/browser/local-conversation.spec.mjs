import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { validateVoiceTurn } from '../../local-voice-service.mjs';

const root = process.cwd(), fixture = path.join(root, 'output/microphone-fixture.wav');
// Native fake hardware generates a tone after file EOF. Keep real
// trailing silence in the file so the turn test measures a speaker's pause.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-t', '3.5', '-i', path.join(root, 'public/assets/voice-reference-clean.wav'), '-af', 'apad=pad_dur=30', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', fixture], { windowsHide: true });
const audioBase64 = readFileSync(path.join(root, 'public/assets/voice-reference-clean.wav')).toString('base64');
const ownVoice = { audioBase64, mimeType: 'audio/wav', voice: 'uploaded-reference' };
test.use({ launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + fixture + '%noloop'] } });

test.beforeEach(async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: false, customVoiceId: null, chatgpt: { status: 'connected', sharing: true }, localVoice: { available: true, status: 'ready', voice: 'uploaded-reference' } } }));
  await page.route('/api/chatgpt/session', route => route.fulfill({ json: { status: 'connected', sharing: true } }));
  await page.route('/api/chatgpt/models', route => route.fulfill({ json: { models: [{ slug: 'local-test-model', displayName: '测试模型' }] } }));
  await page.addInitScript(() => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.voiceTestMicrophone = stream; return stream; };
  });
});

test('native microphone silence submits audio and own-voice playback supports mute, interrupt and release', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let turns = 0;
  await page.route('/api/local-voice/start', route => route.fulfill({ json: ownVoice }));
  await page.route('/api/local-voice/stream', route => {
    const input = route.request().postDataJSON(); validateVoiceTurn(input); turns++;
    return route.fulfill({ contentType: 'application/x-ndjson; charset=utf-8', body: [
      { type: 'recognized', userText: '语音测试' }, { type: 'audio', index: 0, ...ownVoice },
      { type: 'done', heard: true, userText: '语音测试', replyText: '语音测试回应' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  });
  await page.goto('/'); await expect(page.locator('#connection-summary')).toHaveText('可以开始对话');
  await page.locator('#connect').click(); await expect(page.locator('#connect')).toContainText('结束对话');
  await expect.poll(() => turns, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#remote-audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(.3);
  await expect(page.locator('#subtitle')).toBeHidden(); await expect(page.locator('#chat')).toBeHidden(); await expect(page.locator('.voice-strip')).toHaveCount(0);
  await page.screenshot({ path: 'output/voice-dialogue.png', fullPage: true });
  await page.locator('#mute').click(); expect(await page.evaluate(() => window.voiceTestMicrophone.getAudioTracks()[0].enabled)).toBe(false);
  await page.locator('#interrupt').click(); expect(await page.locator('#remote-audio').evaluate(audio => audio.paused)).toBe(true);
  await page.locator('#connect').click(); await expect(page.locator('#connect')).toContainText('开始对话');
  expect(await page.evaluate(() => window.voiceTestMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  expect(errors).toEqual([]);
});

test('cancelling local speech startup releases microphone and discards delayed welcome audio', async ({ page }) => {
  await page.route('/api/local-voice/start', async route => { await new Promise(resolve => setTimeout(resolve, 1300)); await route.fulfill({ json: ownVoice }).catch(() => {}); });
  await page.goto('/'); await page.locator('#connect').click();
  await expect.poll(() => page.evaluate(() => !!window.voiceTestMicrophone)).toBe(true);
  await page.locator('#connect').click();
  await expect(page.locator('#connect')).toContainText('开始对话');
  expect(await page.evaluate(() => window.voiceTestMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  await page.waitForTimeout(1400); await expect(page.locator('#connection-summary')).not.toHaveText('语音对话已连接');
  expect(await page.locator('#remote-audio').evaluate(audio => audio.paused && !audio.getAttribute('src'))).toBe(true);
});

test('start offers account login and returns to the voice interface after authorization', async ({ page, context }) => {
  let sharing = false, connecting = false;
  await page.route('/api/chatgpt/session', route => route.fulfill({ json: { status: sharing ? 'connected' : connecting ? 'connecting' : 'reauth_required', sharing } }));
  await page.route('/api/chatgpt/signin', route => { connecting = true; return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=local-test-state' } }); });
  await context.route('https://auth.openai.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><p>本地测试登录页面</p>' }));
  await page.goto('/'); await expect(page.locator('#connection-summary')).toHaveText('请登录对话账号');
  const popupReady = page.waitForEvent('popup'); await page.locator('#connect').click(); const popup = await popupReady;
  await expect(popup.locator('p')).toHaveText('本地测试登录页面');
  await expect(page.locator('#settings')).toBeVisible(); sharing = true;
  await expect(page.locator('#connection-summary')).toHaveText('可以开始对话');
  await expect(page.locator('#settings')).toBeHidden(); await expect(page.locator('#text-form')).toBeHidden();
  await popup.close();
});
