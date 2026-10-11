// Opt-in real cloud test with the user's supplied recording as controlled microphone input.
// No cloud mocks, no现场 microphone capture, and no credential values in the report.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), fixture = path.join(root, 'output/doubao-live-microphone.wav');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-t', '3.5', '-i', path.join(root, 'public/assets/voice-reference-clean.wav'), '-af', 'apad=pad_dur=90', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', fixture], { windowsHide: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + fixture + '%noloop'] });
let page;
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.liveDoubaoProbe = { events: [], pcmChunks: [], outputBytes: 0, startedAt: 0, error: null };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).includes('/api/doubao/live')) return;
        this.addEventListener('message', event => {
          const probe = window.liveDoubaoProbe, time = performance.now();
          if (event.data instanceof ArrayBuffer) {
            probe.firstPcmAt ??= time; probe.outputBytes += event.data.byteLength;
            if (probe.outputBytes <= 20 * 1024 * 1024) probe.pcmChunks.push(Array.from(new Uint8Array(event.data)));
          } else {
            const message = JSON.parse(event.data); probe.events.push({ type: message.type, time });
            if (message.type === 'ready') probe.readyAt = time;
            if (message.type === 'speech_stopped') probe.speechStoppedAt ??= time;
            if (message.type === 'error') probe.error = message.error;
          }
        });
      }
    };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.liveMicrophone = stream; return stream; };
  });
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.getElementById('connection-summary').textContent === '可以开始验证');
  const safeConfig = await (await page.request.get('http://127.0.0.1:4173/api/config')).json();
  assert.equal(safeConfig.doubao.configured, true); assert.equal(Object.hasOwn(safeConfig.doubao, 'apiKey'), false);
  await page.evaluate(() => { window.liveDoubaoProbe.startedAt = performance.now(); });
  await page.locator('#connect').click();
  await page.waitForFunction(() => window.liveDoubaoProbe.readyAt || window.liveDoubaoProbe.error, null, { timeout: 32000 });
  let failure = await page.evaluate(() => window.liveDoubaoProbe.error); if (failure) throw new Error(failure);
  await page.waitForFunction(() => window.liveDoubaoProbe.firstPcmAt || window.liveDoubaoProbe.error, null, { timeout: 45000 });
  failure = await page.evaluate(() => window.liveDoubaoProbe.error); if (failure) throw new Error(failure);
  await page.waitForFunction(() => {
    const level = Number(document.querySelector('.avatar-panel').style.getPropertyValue('--stage-level'));
    if (!document.getElementById('remote-audio').paused && level > .02) { window.liveDoubaoProbe.audibleAt ??= performance.now(); return true; }
    return false;
  }, null, { timeout: 10000 });
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('#subtitle').isVisible(), false); assert.equal(await page.locator('#chat').isVisible(), false);
  await page.locator('#mute').click(); assert.equal(await page.evaluate(() => window.liveMicrophone.getAudioTracks()[0].enabled), false);
  await page.locator('#interrupt').click(); assert.equal(await page.locator('#remote-audio').evaluate(audio => audio.paused), true);
  await page.screenshot({ path: 'output/doubao-live-dialogue.png', fullPage: true });
  const probe = await page.evaluate(() => window.liveDoubaoProbe);
  await page.locator('#connect').click(); assert.equal(await page.evaluate(() => window.liveMicrophone.getAudioTracks()[0].readyState), 'ended');
  assert.deepEqual(errors, []);
  const pcm = Buffer.concat(probe.pcmChunks.map(chunk => Buffer.from(chunk))), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  await writeFile('output/doubao-live-reply.wav', Buffer.concat([header, pcm]));
  const report = { passed: true, checkedAt: new Date().toISOString(), cloudDialogueVerified: true, voiceId: safeConfig.doubao.voiceId, model: '2.2.0.0', microphoneInput: 'controlled-uploaded-reference', firstAudioSecondsAfterSpeechEnded: probe.speechStoppedAt ? (probe.firstPcmAt - probe.speechStoppedAt) / 1000 : null, firstAudibleSecondsAfterSpeechEnded: probe.speechStoppedAt ? (probe.audibleAt - probe.speechStoppedAt) / 1000 : null, connectionSeconds: (probe.readyAt - probe.startedAt) / 1000, receivedAudioSeconds: pcm.length / 48000, mutePassed: true, interruptPassed: true, releasePassed: true, pageErrors: errors };
  await writeFile('output/doubao-live-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const report = { passed: false, checkedAt: new Date().toISOString(), cloudDialogueVerified: false, error: error.message };
  await writeFile('output/doubao-live-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally { await browser.close(); }
