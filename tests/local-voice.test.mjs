import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVoiceService, validateVoiceTurn } from '../local-voice-service.mjs';
import { pcmWave, LocalConversation } from '../public/local-conversation.js';
import { createServer } from '../server.mjs';

const recording = () => pcmWave([new Float32Array(16000).fill(.05)], 16000);

test('browser PCM is accepted as bounded mono WAV and malformed recordings are rejected', () => {
  assert.doesNotThrow(() => validateVoiceTurn({ audioBase64: recording() }));
  const resampled = pcmWave([new Float32Array(48000).fill(.05)], 48000);
  assert.doesNotThrow(() => validateVoiceTurn({ audioBase64: resampled }));
  assert.equal(Buffer.from(resampled, 'base64').length, 32044);
  for (const audioBase64 of ['not-a-wave', Buffer.from('RIFFtruncated').toString('base64'), recording().slice(8)]) {
    assert.throws(() => validateVoiceTurn({ audioBase64 }), error => error.status === 400);
  }
  const wav = Buffer.from(recording(), 'base64'); wav.writeUInt16LE(2, 22);
  assert.throws(() => validateVoiceTurn({ audioBase64: wav.toString('base64') }), error => error.status === 400);
  assert.throws(() => validateVoiceTurn({ audioBase64: recording(), history: [{ role: 'system', text: 'bad' }] }), error => error.status === 400);
});

test('voice turns preserve context and synthesize the new AI answer with the fixed uploaded voice', async () => {
  const service = new LocalVoiceService(process.cwd()), operations = [];
  service.call = async (operation, input) => {
    operations.push({ operation, input });
    return operation === 'recognize' ? { text: '下一步呢？' } : { audioBase64: recording(), mimeType: 'audio/wav', voice: 'uploaded-reference' };
  };
  const chatgpt = { respond: async (input, delta, signal) => {
    assert.deepEqual(input.messages, [{ role: 'user', text: '我想咨询服务。' }, { role: 'assistant', text: '请告诉我你的需求。' }, { role: 'user', text: '下一步呢？' }]);
    assert.match(input.instructions, /语音对话/);
    return { text: '**先告诉我你需要哪种服务。**' };
  } };
  const result = await service.turn({ audioBase64: recording(), voice: 'not-the-users-voice', history: [{ role: 'user', text: '我想咨询服务。' }, { role: 'assistant', text: '请告诉我你的需求。' }] }, chatgpt);
  assert.equal(result.heard, true); assert.equal(result.voice, 'uploaded-reference');
  assert.deepEqual(operations.map(item => item.operation), ['recognize', 'synthesize']);
  assert.deepEqual(operations[1].input, { text: '先告诉我你需要哪种服务。' });
});

test('silence and failed voice conversion never produce a substitute spoken answer', async () => {
  const service = new LocalVoiceService(process.cwd());
  let called = false;
  service.call = async () => ({ text: '' });
  assert.deepEqual(await service.turn({ audioBase64: recording() }, { respond: () => { called = true; } }), { heard: false });
  assert.equal(called, false);
  service.call = async operation => { if (operation === 'recognize') return { text: '你好' }; throw new Error('voice conversion failed'); };
  await assert.rejects(service.turn({ audioBase64: recording() }, { respond: async () => ({ text: '你好。' }) }), /voice conversion failed/);
});

test('an interrupted model answer is discarded before voice synthesis', async () => {
  const service = new LocalVoiceService(process.cwd()), controller = new AbortController();
  let synthesis = false;
  service.call = async operation => { if (operation === 'recognize') return { text: '你好' }; synthesis = true; };
  await assert.rejects(service.turn({ audioBase64: recording() }, { respond: async () => { controller.abort(); return { text: '你好。' }; } }, controller.signal), error => error.name === 'AbortError');
  assert.equal(synthesis, false);
});

test('interrupting pending audio setup prevents a delayed answer from playing', async () => {
  let release, plays = 0;
  const audio = new EventTarget();
  audio.pause = () => {}; audio.play = async () => { plays++; };
  const conversation = new LocalConversation({ audio, onStatus: () => {}, onAudio: () => new Promise(resolve => { release = resolve; }) });
  conversation.connected = true;
  const pending = conversation.play({ audioBase64: recording(), mimeType: 'audio/wav', voice: 'uploaded-reference' }, conversation.generation);
  conversation.interrupt(); release(); await pending;
  assert.equal(plays, 0); URL.revokeObjectURL(conversation.audioUrl);
});

test('sustained quiet speech does not raise the noise floor or end before the speaker pauses', () => {
  const audio = new EventTarget(); audio.pause = () => {};
  const conversation = new LocalConversation({ audio, onStatus: () => {} });
  Object.assign(conversation, { connected: true, context: { sampleRate: 16000 }, settings: { eagerness: 'auto' }, preRoll: [], chunks: [], energyWindow: [], voiceBlocks: 0 });
  const turns = []; conversation.answer = frames => turns.push(frames);
  const silent = new Float32Array(2048);
  const speech = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 16000) * .02 * Math.sqrt(2));
  for (let i = 0; i < 4; i++) conversation.capture(silent);
  for (let i = 0; i < 80; i++) conversation.capture(speech);
  assert.equal(turns.length, 0); assert.equal(conversation.recording, true);
  for (let i = 0; i < 8; i++) conversation.capture(silent);
  assert.equal(turns.length, 1);
  assert.ok(turns[0].reduce((sum, frame) => sum + frame.length, 0) >= 80 * 2048);
});

test('repeated interruptions cancel queued CPU work without creating a serial backlog', async () => {
  const service = new LocalVoiceService(process.cwd()), writes = [];
  service.status = 'ready'; service.prepare = async () => {};
  service.worker = { stdin: { write: (line, callback) => { writes.push(JSON.parse(line)); callback(); } } };
  for (let i = 0; i < 6; i++) {
    const controller = new AbortController();
    const result = service.call('synthesize', { text: '尚未播放的回答' }, controller.signal);
    const rejection = assert.rejects(result, /已打断/);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejection;
  }
  assert.equal(writes.length, 1);
  const next = service.call('recognize', { audioBase64: recording() });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
  service.finishOperation({ id: writes[0].id, result: { discarded: true } });
  assert.equal(writes.length, 2); assert.equal(writes[1].operation, 'recognize');
  service.finishOperation({ id: writes[1].id, result: { text: '下一次提问' } });
  assert.deepEqual(await next, { text: '下一次提问' });
});

test('quieter continuing speech after barge-in uses the listening threshold', () => {
  const audio = new EventTarget(); audio.pause = () => {};
  const conversation = new LocalConversation({ audio, onStatus: () => {} });
  Object.assign(conversation, { connected: true, playing: true, playStarted: performance.now() - 1000, context: { sampleRate: 16000 }, settings: { eagerness: 'auto' }, preRoll: [], chunks: [], energyWindow: [], voiceBlocks: 0 });
  const turns = []; conversation.answer = frames => turns.push(frames);
  const frame = rms => Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 16000) * rms * Math.sqrt(2));
  for (let i = 0; i < 4; i++) conversation.capture(frame(0));
  for (let i = 0; i < 2; i++) conversation.capture(frame(.04));
  assert.equal(conversation.playing, false);
  for (let i = 0; i < 16; i++) conversation.capture(frame(.02));
  assert.equal(turns.length, 0);
  for (let i = 0; i < 8; i++) conversation.capture(frame(0));
  assert.equal(turns.length, 1);
});

test('an aborted active CPU operation retains a deadline so a stalled worker can recover', async t => {
  const deadlines = new Set(); let kills = 0;
  t.mock.method(globalThis, 'setTimeout', callback => { const handle = { callback }; deadlines.add(handle); return handle; });
  t.mock.method(globalThis, 'clearTimeout', handle => deadlines.delete(handle));
  const service = new LocalVoiceService(process.cwd()); service.status = 'ready'; service.prepare = async () => {};
  service.worker = { kill: () => { kills++; }, stdin: { write: (line, callback) => callback() } };
  const controller = new AbortController();
  const rejection = assert.rejects(service.call('synthesize', { text: '延迟的回答' }, controller.signal), /已打断/);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejection;
  assert.equal(deadlines.size, 1);
  for (const handle of [...deadlines]) handle.callback();
  assert.equal(kills, 1);
});

test('local voice HTTP guards origin, account permission, malformed wave and private files', async t => {
  let sharing = true, turns = 0;
  const localVoice = { publicStatus: async () => ({ available: true, voice: 'uploaded-reference' }), welcome: async () => ({ voice: 'uploaded-reference', audioBase64: recording(), mimeType: 'audio/wav' }), turn: async () => { turns++; return { heard: false }; }, close: () => {} };
  const chatgpt = { publicSession: async () => ({ sharing }), cancelSignIn: () => {} };
  const server = createServer({ localVoice, chatgpt }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, data, headers = {}) => fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await post('/api/local-voice/start', {}, { origin: 'https://other.test' })).status, 403);
  sharing = false; assert.equal((await post('/api/local-voice/start', {})).status, 401);
  sharing = true; assert.equal((await post('/api/local-voice/turn', { audioBase64: 'malformed' })).status, 400); assert.equal(turns, 0);
  assert.equal((await post('/api/local-voice/turn', { audioBase64: recording() })).status, 200); assert.equal(turns, 1);
  const welcome = await (await post('/api/local-voice/start', {})).json(); assert.equal(welcome.voice, 'uploaded-reference');
  assert.equal((await fetch(base + '/.runtime/openvoice-models/checkpoints/converter/checkpoint.pth')).status, 404);
});
