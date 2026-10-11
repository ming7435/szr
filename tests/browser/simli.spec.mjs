import { test, expect } from '@playwright/test';

const faceId = '16a939c3-1552-4cd3-b0d1-2d116d8a11d0';
const configuration = (enabled = true) => ({ apiConfigured: false, localVoice: { available: true }, chatgpt: { sharing: true }, doubao: { selected: true, configured: true, voice: 'uploaded-reference' }, simli: { enabled, configured: enabled, credentialConfigured: true, faceId: enabled ? faceId : null } });
const pcm = Buffer.alloc(48000);
for (let n = 0; n < 24000; n++) pcm.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 330 / 24000) * 5000), n * 2);

async function installRTC(page) {
  await page.addInitScript(() => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await acquire(options); window.testMicrophone = stream; return stream; };
    window.makeSimliAnswer = async offer => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
      const painter = canvas.getContext('2d');
      window.testFrameColor = '#69aab8';
      window.testDrawing = setInterval(() => { painter.fillStyle = window.testFrameColor; painter.fillRect(0, 0, 160, 120); painter.fillStyle = '#fff'; painter.fillText('RTC TEST', 20, 55); }, 30);
      const frames = canvas.captureStream(30);
      const audio = new AudioContext(); await audio.resume();
      const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const stream = new MediaStream([...frames.getTracks(), ...destination.stream.getTracks()]);
      const peer = new RTCPeerConnection();
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      window.testRemote = { peer, gain, audio, stream };
      (window.testRemotes ||= []).push(window.testRemote);
      await peer.setRemoteDescription(offer); await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete') await new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); }));
      return peer.localDescription.toJSON();
    };
  });
}

test('video setup keeps key private and pending model leaves current voice mode available', async ({ page }) => {
  let enabled = false, payload;
  await page.route('/api/config', route => route.fulfill({ json: configuration(enabled) }));
  await page.route('/api/simli/settings', route => { payload = route.request().postDataJSON(); enabled = true; return route.fulfill({ json: configuration(true).simli }); });
  await page.goto('/'); await page.locator('#settings-open').click();
  await expect(page.locator('#simli-status')).toContainText('人像模型');
  await page.locator('#simli-api-key').fill('replacement-private-key');
  await page.locator('#simli-face-id').fill(faceId); await page.locator('#simli-own-portrait').check(); await page.locator('#simli-enabled').check();
  await page.locator('#simli-save').click();
  await expect(page.locator('#simli-api-key')).toHaveValue('');
  expect(payload.faceId).toBe(faceId); expect(payload.enabled).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('replacement-private-key');
  await page.locator('#settings-close').click();
  await expect(page.locator('#connect')).toContainText('开始对话');
  await expect(page.locator('#live-avatar-video')).toBeHidden();
  await expect(page.locator('#subtitle')).toBeHidden(); await expect(page.locator('#text-form')).toBeHidden();
});

test('real WebRTC stream owns synchronized sound and video; interrupt clears old audio and releases tracks', async ({ page }) => {
  await installRTC(page);
  let doubao, simli, inputBytes = 0, skips = 0, interrupts = 0, speakingSent = false;
  await page.route('/api/config', route => route.fulfill({ json: configuration() }));
  await page.route('/api/simli/session', route => route.fulfill({ json: { sessionToken: 'temporary-test-session', iceServers: [], sampleRate: 16000, maxSessionLength: 900 } }));
  await page.routeWebSocket('wss://api.simli.ai/compose/webrtc/p2p**', ws => {
    simli = ws;
    ws.onMessage(async message => {
      if (Buffer.isBuffer(message)) {
        inputBytes += message.length;
        await page.evaluate(() => { window.testRemote.gain.gain.value = .06; window.testFrameColor = '#678e59'; });
        if (!speakingSent) { speakingSent = true; ws.send('SPEAK'); }
        return;
      }
      if (message === 'SKIP') { skips++; speakingSent = false; return; }
      if (message === 'DONE') return;
      const offer = JSON.parse(message), answer = await page.evaluate(offer => window.makeSimliAnswer(offer), offer);
      ws.send(JSON.stringify(answer));
    });
  });
  await page.routeWebSocket('**/api/doubao/live', ws => {
    doubao = ws;
    ws.onMessage(message => {
      if (Buffer.isBuffer(message)) return;
      const event = JSON.parse(message);
      if (event.type === 'start') ws.send(JSON.stringify({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 }));
      if (event.type === 'interrupt') interrupts++;
    });
  });
  await page.goto('/'); await page.locator('#connect').click();
  await expect(page.locator('#connection-summary')).toHaveText('声画对话已连接');
  await expect(page.locator('#live-avatar-video')).toBeVisible();
  expect(await page.locator('#live-avatar-video').evaluate(video => [video.srcObject.getAudioTracks().length, video.srcObject.getVideoTracks().length])).toEqual([1, 1]);
  await page.locator('#mute').click();
  doubao.send(JSON.stringify({ type: 'response_started', replyId: 'old', questionId: 'q1' })); doubao.send(pcm);
  doubao.send(JSON.stringify({ type: 'response_ended', replyId: 'old' }));
  await expect.poll(() => inputBytes).toBe(32000); // Same one-second answer at 16 kHz, no invented tail.
  await expect.poll(() => page.locator('#live-avatar-video').evaluate(video => !video.muted && !video.paused && video.currentTime > .2)).toBe(true);
  expect(await page.locator('#remote-audio').evaluate(audio => audio.paused && audio.srcObject === null)).toBe(true);
  const previousStreamId = await page.locator('#live-avatar-video').evaluate(video => video.srcObject.id);
  simli.send('SILENT'); // Control-plane silence must not cut off RTP audio still playing.
  await page.waitForTimeout(100);
  expect(await page.locator('#live-avatar-video').evaluate(video => video.muted)).toBe(false);
  await page.locator('#interrupt').click(); await expect.poll(() => interrupts).toBe(1);
  expect(await page.locator('#live-avatar-video').evaluate(video => video.muted && video.paused)).toBe(true);
  await expect.poll(() => skips).toBe(1);
  const stoppedBytes = inputBytes; doubao.send(pcm); await page.waitForTimeout(100); expect(inputBytes).toBe(stoppedBytes);
  // The old stream is isolated; a fresh answer does not depend on a SKIP acknowledgement.
  doubao.send(JSON.stringify({ type: 'response_started', replyId: 'fresh', questionId: 'q2' })); doubao.send(pcm);
  await expect.poll(() => inputBytes).toBeGreaterThan(stoppedBytes);
  await expect.poll(() => page.locator('#live-avatar-video').evaluate(video => !video.muted)).toBe(true);
  expect(await page.locator('#live-avatar-video').evaluate(video => video.srcObject.id)).not.toBe(previousStreamId);
  await page.locator('#connect').click();
  await expect(page.locator('#live-avatar-video')).toBeHidden();
  expect(await page.locator('#live-avatar-video').evaluate(video => video.srcObject)).toBe(null);
  expect(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => { clearInterval(window.testDrawing); window.testRemotes.forEach(remote => { remote.peer.close(); remote.stream.getTracks().forEach(track => track.stop()); remote.audio.close(); }); });
});

test('cancelling video setup never starts microphone or accepts a late remote answer', async ({ page }) => {
  await installRTC(page);
  await page.route('/api/config', route => route.fulfill({ json: configuration() }));
  await page.route('/api/simli/session', route => route.fulfill({ json: { sessionToken: 'temporary-test-session', iceServers: [], sampleRate: 16000 } }));
  let socket;
  await page.routeWebSocket('wss://api.simli.ai/compose/webrtc/p2p**', ws => { socket = ws; ws.onMessage(() => {}); });
  await page.goto('/'); await page.locator('#connect').click();
  await expect.poll(() => !!socket).toBe(true);
  await page.locator('#connect').click(); await page.waitForTimeout(200);
  expect(await page.evaluate(() => !!window.testMicrophone)).toBe(false);
  await expect(page.locator('#live-avatar-video')).toBeHidden();
  await expect(page.locator('#connect')).toContainText('开始对话');
});

test('early SILENT and later generation end preserve audible tail and return to listening without a reset ack', async ({ page }) => {
  await installRTC(page);
  let doubao, simli, bytes = 0, skipCount = 0, sessionCount = 0, playing = false;
  await page.route('/api/config', route => route.fulfill({ json: configuration() }));
  await page.route('/api/simli/session', route => { sessionCount++; return route.fulfill({ json: { sessionToken: 'temporary-test-session', iceServers: [], sampleRate: 16000 } }); });
  await page.routeWebSocket('wss://api.simli.ai/compose/webrtc/p2p**', ws => {
    simli = ws;
    ws.onMessage(async message => {
      if (Buffer.isBuffer(message)) {
        bytes += message.length;
        if (!playing) {
          playing = true;
          await page.evaluate(() => {
            window.testRemote.gain.gain.value = .06;
            setTimeout(() => { window.testRemote.gain.gain.value = 0; }, 1150);
          });
          ws.send('SPEAK');
        }
        return;
      }
      if (message === 'SKIP') { skipCount++; return; }
      if (message === 'DONE') return;
      ws.send(JSON.stringify(await page.evaluate(offer => window.makeSimliAnswer(offer), JSON.parse(message))));
    });
  });
  await page.routeWebSocket('**/api/doubao/live', ws => {
    doubao = ws;
    ws.onMessage(message => { if (!Buffer.isBuffer(message) && JSON.parse(message).type === 'start') ws.send(JSON.stringify({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 })); });
  });
  await page.goto('/'); await page.locator('#connect').click();
  await expect(page.locator('#connection-summary')).toHaveText('声画对话已连接'); await page.locator('#mute').click();
  const streamId = await page.locator('#live-avatar-video').evaluate(video => video.srcObject.id);
  doubao.send(JSON.stringify({ type: 'response_started', replyId: 'first' })); doubao.send(pcm);
  await expect(page.locator('#avatar-status')).toHaveText('我正在回应');
  simli.send('SILENT'); await page.waitForTimeout(50);
  doubao.send(JSON.stringify({ type: 'response_ended', replyId: 'first' }));
  await expect.poll(() => bytes).toBe(32000);
  expect(await page.locator('#live-avatar-video').evaluate(video => video.muted)).toBe(false);
  await expect(page.locator('#avatar-status')).toHaveText('我正在听');
  playing = false;
  doubao.send(JSON.stringify({ type: 'response_started', replyId: 'second' })); doubao.send(pcm);
  doubao.send(JSON.stringify({ type: 'response_ended', replyId: 'second' }));
  await expect.poll(() => bytes).toBe(64000);
  await expect(page.locator('#avatar-status')).toHaveText('我正在回应');
  await expect(page.locator('#avatar-status')).toHaveText('我正在听');
  expect(skipCount).toBe(1); expect(sessionCount).toBe(2);
  expect(await page.locator('#live-avatar-video').evaluate(video => video.srcObject.id)).not.toBe(streamId);
  await page.locator('#connect').click();
  await page.evaluate(() => { clearInterval(window.testDrawing); window.testRemotes.forEach(remote => { remote.peer.close(); remote.stream.getTracks().forEach(track => track.stop()); remote.audio.close(); }); });
});
