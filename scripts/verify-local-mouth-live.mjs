// Opt-in actual cloud/model/browser check. Uses the supplied recording, not the physical microphone.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), output = path.join(root, 'output'), fixture = path.join(output, 'local-mouth-microphone.wav');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-t', '3.5', '-i', path.join(root, 'public/assets/voice-reference-clean.wav'), '-af', 'apad=pad_dur=90', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', fixture], { windowsHide: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + fixture + '%noloop'] });
let page;
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = window.localMouthProbe = { cloudPcm: [], cloudChunks: [], cloudBytes: 0, pairedPcm: [], frames: 0, drawn: 0, errors: [], eyeStates: [], modelWarmRequests: 0, headPoses: [] };
    document.addEventListener('DOMContentLoaded', () => {
      const canvas = document.getElementById('face-expression-canvas');
      new MutationObserver(() => { if (canvas.dataset.state && !probe.eyeStates.includes(canvas.dataset.state)) probe.eyeStates.push(canvas.dataset.state); }).observe(canvas, { attributes: true });
      const layers = document.getElementById('portrait-layers'), mouth = document.getElementById('local-mouth-canvas');
      new MutationObserver(() => { if (!mouth.hidden) { const pose = layers.dataset.pitch + ',' + layers.dataset.yaw; if (!probe.headPoses.includes(pose)) probe.headPoses.push(pose); } }).observe(layers, { attributes: true, attributeFilter: ['data-pitch', 'data-yaw'] });
    });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        const url = String(args[0]);
        if (!url.includes('/api/doubao/live') && !url.includes('/api/avatar/live')) return;
        if (url.includes('/api/avatar/live')) {
          const send = this.send.bind(this);
          this.send = data => { if (typeof data === 'string' && JSON.parse(data).type === 'warm') probe.modelWarmRequests++; send(data); };
        }
        this.addEventListener('message', event => {
          const time = performance.now();
          if (event.data instanceof ArrayBuffer) {
            probe.firstCloudPcmAt ??= time;
            probe.cloudBytes += event.data.byteLength;
            probe.cloudChunks.push({ milliseconds: time - probe.firstCloudPcmAt, bytes: event.data.byteLength });
            // Native batch 2 needs both 50ms frames' complete mel lookahead.
            if (probe.cloudBytes >= 12900) probe.firstBatchAudioAvailableAt ??= time;
            probe.cloudPcm.push(Array.from(new Uint8Array(event.data))); return;
          }
          const message = JSON.parse(event.data);
          if (message.type === 'error') probe.errors.push(message.error);
          if (url.includes('/api/doubao/live')) {
            if (message.type === 'ready') probe.voiceReadyAt = time;
            if (message.type === 'speech_stopped') probe.speechStoppedAt ??= time;
          } else {
            if (message.type === 'ready') { probe.modelReadyAt = time; probe.device = message.device; probe.lowerFaceMotion = message.lowerFaceMotion; probe.faceRegion = message.region; }
            if (message.type === 'frame') { probe.firstModelFrameAt ??= time; probe.cloudBytesAtFirstFrame ??= probe.cloudBytes; probe.frames++; probe.pairedPcm.push(message.pcm); }
          }
        });
      }
    };
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function (...args) {
      const gain = createGain.apply(this, args);
      if (this.sampleRate === 24000) {
        const analyser = this.createAnalyser(); analyser.fftSize = 1024; gain.connect(analyser);
        window.probeOutputAnalyser = analyser; window.probeOutputContext = this;
      }
      return gain;
    };
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.probeMicrophone = stream; return stream; };
    setInterval(() => {
      const canvas = document.getElementById('local-mouth-canvas');
      if (canvas && !canvas.hidden) {
        probe.firstVisibleAt ??= performance.now(); probe.drawn = Math.max(probe.drawn, Number(canvas.dataset.frameIndex) + 1);
        const analyser = window.probeOutputAnalyser;
        if (analyser) {
          const values = new Float32Array(1024); analyser.getFloatTimeDomainData(values);
          const energy = values.reduce((sum, n) => sum + n * n, 0);
          if (energy > .005) probe.firstAudibleAndVisibleAt ??= performance.now();
        }
      }
    }, 10);
  });
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.getElementById('face-expression-canvas').dataset.ready === 'true');
  await page.waitForFunction(() => document.getElementById('portrait-layers').dataset.motionReady === 'true');
  await page.waitForFunction(() => document.getElementById('connection-summary').textContent === '可以开始验证');
  const config = await (await page.request.get('http://127.0.0.1:4173/api/config')).json();
  assert.equal(config.localAvatar.enabled, true); assert.equal(config.doubao.configured, true); assert.equal(config.simli.enabled, false);
  assert.equal(config.localAvatar.lowerFaceMotion, true);
  await page.evaluate(() => { localMouthProbe.startedAt = performance.now(); });
  await page.locator('#connect').click();
  await page.waitForFunction(() => localMouthProbe.firstAudibleAndVisibleAt || localMouthProbe.errors.length, null, { timeout: 65000 });
  let probe = await page.evaluate(() => localMouthProbe); assert.deepEqual(probe.errors, []); assert.ok(probe.firstAudibleAndVisibleAt);
  assert.equal(probe.lowerFaceMotion, 'audio-driven-photo-warp');
  assert.ok(probe.modelWarmRequests >= 2, 'Model did not prepare during connect and listening');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(output, 'local-mouth-live.png'), fullPage: true });
  assert.equal(await page.locator('#chat').isVisible(), false); assert.equal(await page.locator('#subtitle').isVisible(), false);
  await page.locator('#mute').click(); assert.equal(await page.evaluate(() => probeMicrophone.getAudioTracks()[0].enabled), false);
  await page.locator('#interrupt').click();
  assert.equal(await page.locator('#local-mouth-canvas').isVisible(), false);
  assert.equal(await page.locator('#local-mouth-canvas').evaluate(canvas => Number(canvas.dataset.audioEnergy)), 0);
  await page.waitForTimeout(100);
  const quiet = await page.evaluate(() => { const a = new Float32Array(1024); probeOutputAnalyser.getFloatTimeDomainData(a); return a.reduce((sum, n) => sum + n * n, 0); });
  assert.ok(quiet < .00001, `Audio remained after interrupt: ${quiet}`);
  await page.waitForTimeout(300); assert.equal(await page.locator('#local-mouth-canvas').isVisible(), false);
  probe = await page.evaluate(() => localMouthProbe);
  assert.ok(['listening', 'thinking', 'responding'].every(state => probe.eyeStates.includes(state)), 'Eye/brow state did not follow actual conversation');
  assert.ok(probe.headPoses.length > 3, 'Shared head pose did not follow actual spoken response');
  await page.locator('#connect').click(); assert.equal(await page.evaluate(() => probeMicrophone.getAudioTracks()[0].readyState), 'ended');
  assert.deepEqual(errors, []);
  const cloud = Buffer.concat(probe.cloudPcm.map(bytes => Buffer.from(bytes)));
  const paired = Buffer.concat(probe.pairedPcm.map(bytes => Buffer.from(bytes, 'base64')));
  assert.ok(paired.length > 48000); assert.deepEqual(paired, cloud.subarray(0, paired.length));
  const report = { passed: true, checkedAt: new Date().toISOString(), actualCloudAndGPU: true, voiceId: config.doubao.voiceId, device: probe.device, lowerFaceMotion: probe.lowerFaceMotion, faceRegion: probe.faceRegion, microphone: 'controlled uploaded-reference recording', framesReceived: probe.frames, framesDrawnThrough: probe.drawn, originalPcmUnchanged: true, firstCloudAudioSecondsAfterSpeechEnded: (probe.firstCloudPcmAt - probe.speechStoppedAt) / 1000, firstModelFrameSecondsAfterSpeechEnded: (probe.firstModelFrameAt - probe.speechStoppedAt) / 1000, firstAudibleAndVisibleSecondsAfterSpeechEnded: (probe.firstAudibleAndVisibleAt - probe.speechStoppedAt) / 1000, additionalMouthPipelineSeconds: (probe.firstAudibleAndVisibleAt - probe.firstCloudPcmAt) / 1000, startupSeconds: (probe.voiceReadyAt - probe.startedAt) / 1000, mutePassed: true, interruptStopsSoundAndMouth: true, lateFramesStayHidden: true, microphoneReleased: true, basicEyeBrowMotion: true, eyeStates: probe.eyeStates, fullFaceRealtimeModel: false, commercialDeploymentAllowed: false, pageErrors: errors };
  report.firstBatchAudioAvailableSecondsAfterCloud = (probe.firstBatchAudioAvailableAt - probe.firstCloudPcmAt) / 1000;
  report.firstFrameSecondsAfterBatchAudioAvailable = (probe.firstModelFrameAt - probe.firstBatchAudioAvailableAt) / 1000;
  report.cloudBytesAtFirstFrame = probe.cloudBytesAtFirstFrame;
  report.firstCloudChunks = probe.cloudChunks.slice(0, 8);
  report.modelWarmRequests = probe.modelWarmRequests;
  report.sharedHeadMotion = true; report.headPosesWhileSpeaking = probe.headPoses.length; report.interruptClearsFacialActivity = true;
  await writeFile(path.join(output, 'local-mouth-live-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const report = { passed: false, checkedAt: new Date().toISOString(), actualCloudAndGPU: false, error: error.message };
  if (page) await page.screenshot({ path: path.join(output, 'local-mouth-live-failed.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'local-mouth-live-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally { await browser.close(); }
