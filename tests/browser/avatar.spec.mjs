import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: false, customVoiceId: null, model: 'gpt-realtime-2.1-mini' } }));
});

test('portrait and conversation controls load without the removed voice panel', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('#connection-summary')).not.toHaveText('正在检查连接');
  expect(await page.locator('#portrait').evaluate(image => image.complete && image.naturalWidth === 1145 && image.naturalHeight === 1374)).toBe(true);
  await expect(page.locator('.voice-strip')).toHaveCount(0);
  await expect(page.locator('#preview-reference')).toHaveCount(0);
  await expect(page.locator('#connect')).toBeVisible();
  expect(errors).toEqual([]); await page.screenshot({ path: 'output/desktop.png', fullPage: true });
});

test('offline AI status is honest and settings persist', async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: false, customVoiceId: null, model: 'gpt-realtime-2.1-mini' } }));
  await page.goto('/'); await expect(page.locator('#connection-summary')).toHaveText('AI 服务待配置');
  await page.locator('#connect').click(); await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#setup-notice')).toContainText('未配置');
  await page.locator('#persona').fill('用中文简洁回答。'); await page.locator('#vad-eagerness').selectOption('low');
  await page.locator('#settings-save').click(); await page.reload(); await page.locator('#settings-open').click();
  await expect(page.locator('#persona')).toHaveValue('用中文简洁回答。'); await expect(page.locator('#vad-eagerness')).toHaveValue('low');
});

test('the avatar keeps one voice and ignores a legacy built-in voice selection', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('avatar-settings')) localStorage.setItem('avatar-settings', JSON.stringify({ voice: 'cedar', persona: '你的名字是李云龙。固定中文回答。', eagerness: 'low' }));
  });
  await page.goto('/'); await page.locator('#settings-open').click();
  await expect(page.locator('#voice-identity')).toHaveText('固定音色：你上传的声音');
  await expect(page.locator('#voice-mode')).toHaveCount(0);
  await expect(page.locator('#demo-play')).toHaveCount(0);
  await expect(page.locator('.voice-strip')).toHaveCount(0);
  await expect(page.locator('#settings')).not.toContainText('内置音色');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('avatar-settings')))).toEqual({ persona: '固定中文回答。', eagerness: 'low' });
  await page.reload(); await page.locator('#settings-open').click();
  await expect(page.locator('#persona')).toHaveValue('固定中文回答。');
});

test('voice enrollment is required before opening the microphone for conversation', async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: true, customVoiceId: null } }));
  await page.addInitScript(() => { window.testMicrophoneRequests = 0; navigator.mediaDevices.getUserMedia = async () => { window.testMicrophoneRequests++; throw new Error('must not acquire'); }; });
  await page.goto('/'); await page.locator('#connect').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#connection-summary')).toHaveText('数字人音色待接入');
  expect(await page.evaluate(() => window.testMicrophoneRequests)).toBe(0);
});

test('mobile layout and voice setup fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/mobile.png', fullPage: true });
  await page.locator('#settings-open').click(); await expect(page.locator('#consent-phrase')).toBeVisible();
  expect(await page.locator('#settings').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.locator('#record-consent').click(); await expect(page.locator('#record-consent')).toHaveText('■ 停止录制');
  await page.waitForTimeout(350); await page.locator('#record-consent').click(); await expect(page.locator('#consent-preview')).toBeVisible();
  await expect(page.locator('#create-voice')).toBeEnabled(); await page.screenshot({ path: 'output/voice-setup.png' });
});

test('native WebRTC carries transcripts, text input, interruptions and reconnects', async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: true, customVoiceId: 'voice_local_test', model: 'gpt-realtime-2.1-mini' } }));
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async config => { const stream = await getUserMedia(config); window.testMicrophone = stream; return stream; };
  });
  await page.route('/api/session', async route => {
    const request = route.request().postDataJSON();
    expect(request.voice).toBeUndefined();
    const sdp = await page.evaluate(async offer => {
      window.testServerPeer?.close(); const peer = new RTCPeerConnection(); window.testServerPeer = peer;
      const context = new AudioContext(); window.testAudioContext = context;
      const oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
      oscillator.frequency.value = 170; gain.gain.value = .13; oscillator.connect(gain); gain.connect(output); oscillator.start();
      peer.addTrack(output.stream.getAudioTracks()[0], output.stream);
      peer.ondatachannel = e => {
        const channel = e.channel; window.testChannel = channel; window.testReceived = [];
        const send = event => channel.send(JSON.stringify(event));
        channel.onmessage = m => {
          const event = JSON.parse(m.data); window.testReceived.push(event);
          if (event.type === 'conversation.item.create') {
            send({ type: 'response.created', response: { id: 'r-test' } }); send({ type: 'output_audio_buffer.started', response_id: 'r-test' });
            send({ type: 'response.output_audio_transcript.delta', response_id: 'r-test', item_id: 'a-test', delta: '你好，我收到你的消息了。' });
          }
        };
      };
      await peer.setRemoteDescription({ type: 'offer', sdp: offer }); await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete') await new Promise(resolve => { const timer = setTimeout(resolve, 3000); peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }); });
      return peer.localDescription.sdp;
    }, request.sdp);
    await route.fulfill({ json: { sdp } });
  });
  await page.goto('/');
  await page.locator('#connect').click(); await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接', { timeout: 25000 });
  // The voice-only page hides composition; drive this transport check internally.
  await page.locator('#message').evaluate(input => { input.value = '你好'; }); await page.locator('#text-form').evaluate(form => form.requestSubmit());
  await expect(page.locator('.chat-message.assistant .message-text')).toHaveText('你好，我收到你的消息了。');
  await page.locator('#mute').click(); expect(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].enabled)).toBe(false);
  await page.locator('#mute').click(); expect(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].enabled)).toBe(true);
  await page.locator('#interrupt').click();
  await expect.poll(() => page.evaluate(() => window.testReceived.some(event => event.type === 'output_audio_buffer.clear'))).toBe(true);
  await expect(page.locator('.message-meta')).toHaveText('已打断');
  await page.locator('#connect').click(); await expect(page.locator('#connect')).toContainText('开始对话');
  expect(await page.evaluate(() => window.testMicrophone.getAudioTracks()[0].readyState)).toBe('ended');
  await page.locator('#connect').click(); await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接', { timeout: 25000 });
  await page.locator('#connect').click();
});

test('closing setup during microphone acquisition releases the pending recording stream', async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.testRecordingRequests = 0;
    navigator.mediaDevices.getUserMedia = async config => {
      window.testRecordingRequests++;
      const stream = await getUserMedia(config); window.testPendingStream = stream;
      await new Promise(resolve => setTimeout(resolve, 500)); return stream;
    };
  });
  await page.goto('/'); await page.locator('#settings-open').click();
  await page.locator('#record-consent').click({ clickCount: 2 }); await page.locator('#settings-close').click();
  await expect.poll(() => page.evaluate(() => window.testPendingStream?.getAudioTracks()[0]?.readyState)).toBe('ended');
  expect(await page.evaluate(() => window.testRecordingRequests)).toBe(1);
});

test('a pending realtime connection can be cancelled and cannot later reopen', async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: true, customVoiceId: 'voice_local_test', model: 'gpt-realtime-2.1-mini' } }));
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async config => { const stream = await getUserMedia(config); window.testMicrophone = stream; return stream; };
  });
  await page.route('/api/session', async route => { await new Promise(resolve => setTimeout(resolve, 1200)); await route.fulfill({ status: 502, json: { error: 'delayed-test-response' } }).catch(() => {}); });
  await page.goto('/');
  await page.locator('#connect').click(); await expect(page.locator('#connect')).toContainText('取消连接');
  await page.locator('#connect').click();
  await expect(page.locator('#connect')).toContainText('开始对话');
  await expect.poll(() => page.evaluate(() => window.testMicrophone?.getAudioTracks()[0]?.readyState)).toBe('ended');
  await page.waitForTimeout(1400); await expect(page.locator('#connection-summary')).not.toHaveText('语音对话已连接');
});
