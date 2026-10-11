// Opt-in actual browser/backend check. Uses controlled microphone input;
// account, recognition, model and own-voice synthesis are never mocked.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), fixture = path.join(root, 'output/live-microphone-fixture.wav');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-t', '3.5', '-i', path.join(root, 'public/assets/voice-reference-clean.wav'), '-af', 'apad=pad_dur=90', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', fixture], { windowsHide: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + fixture + '%noloop'] });
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fastVoiceProbe = { requests: 0, plays: [], done: null };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.testMicrophone = stream; return stream; };
    const original = window.fetch;
    window.fetch = async (...args) => {
      const isTurn = args[0] === '/api/local-voice/stream';
      if (isTurn) { window.fastVoiceProbe.requests++; window.fastVoiceProbe.requestAt = performance.now(); }
      const response = await original(...args);
      if (isTurn) response.clone().text().then(text => {
        const events = text.trim().split('\n').map(line => JSON.parse(line));
        const done = events.find(event => event.type === 'done'), error = events.find(event => event.type === 'error');
        window.fastVoiceProbe.done = done; window.fastVoiceProbe.error = error;
        window.fastVoiceProbe.chunks = events.filter(event => event.type === 'audio').map(event => ({ index: event.index, voice: event.voice, duration: event.duration }));
      }).catch(() => {});
      return response;
    };
    document.addEventListener('play', event => {
      if (event.target.id === 'remote-audio' && window.fastVoiceProbe.requestAt) window.fastVoiceProbe.plays.push({ elapsedSeconds: (performance.now() - window.fastVoiceProbe.requestAt) / 1000, src: event.target.src });
    }, true);
  });
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.querySelector('#connection-summary').textContent === '可以开始对话', { timeout: 20000 });
  await page.locator('#connect').click();
  await page.waitForFunction(() => window.fastVoiceProbe.plays.length > 0, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#remote-audio').currentTime > .2, { timeout: 15000 });
  await page.waitForFunction(() => !!window.fastVoiceProbe.done || !!window.fastVoiceProbe.error, { timeout: 90000 });
  const probe = await page.evaluate(() => window.fastVoiceProbe);
  assert.ok(!probe.error, probe.error?.error); assert.ok(probe.done.heard); assert.ok(probe.done.replyText.trim()); assert.ok(probe.plays[0].elapsedSeconds > 0);
  assert.ok(probe.chunks.every(chunk => chunk.voice === 'uploaded-reference'));
  assert.equal(await page.locator('#subtitle').isVisible(), false); assert.equal(await page.locator('#chat').isVisible(), false); assert.equal(await page.locator('.voice-strip').count(), 0);
  await page.locator('#mute').click(); assert.equal(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].enabled), false);
  await page.locator('#interrupt').click(); assert.equal(await page.locator('#remote-audio').evaluate(audio => audio.paused), true);
  await page.screenshot({ path: 'output/fast-voice-dialogue.png', fullPage: true });
  await page.locator('#connect').click(); assert.equal(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].readyState), 'ended'); assert.deepEqual(errors, []);
  const report = { passed: true, checkedAt: new Date().toISOString(), realBrowserAudio: true, realAiReply: true, microphoneInput: 'controlled-uploaded-reference', firstAudibleReplySeconds: probe.plays[0].elapsedSeconds, model: probe.done.model, chunks: probe.chunks, timings: probe.done.timings, mutePassed: true, interruptPassed: true, releasePassed: true, pageErrors: errors };
  await mkdir(path.join(root, 'output'), { recursive: true }); await writeFile(path.join(root, 'output/fast-browser-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
