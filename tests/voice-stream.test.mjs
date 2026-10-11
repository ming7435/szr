import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVoiceService, validateVoiceTurn } from '../local-voice-service.mjs';
import { ChatGPTService } from '../chatgpt-service.mjs';
import { LocalConversation, pcmWave } from '../public/local-conversation.js';
import { createServer } from '../server.mjs';

const audio = () => ({ voice: 'uploaded-reference', mimeType: 'audio/wav', audioBase64: pcmWave([new Float32Array(16000).fill(.05)], 16000), duration: 1 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('voice mode uses a supported fast model without altering ordinary chat requests', async () => {
  const sent = [], service = new ChatGPTService(process.cwd(), { fetch: async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('data: {"type":"response.output_text.delta","delta":"你好。"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  service.models = async () => [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-luna' }]; service.accessToken = async () => 'test-token';
  await service.respond({ voiceMode: true, messages: [{ role: 'user', text: '你好' }] }, () => {});
  assert.equal(sent[0].model, 'gpt-6-luna'); assert.deepEqual(sent[0].reasoning, { effort: 'none' });
  await service.respond({ messages: [{ role: 'user', text: '你好' }] }, () => {});
  assert.equal(sent[1].model, 'gpt-6.1-sol'); assert.equal(sent[1].reasoning, undefined);
});

test('first own-voice audio arrives before remaining speech conversion finishes, without losing text', async () => {
  const service = new LocalVoiceService(process.cwd()), events = [], spoken = [];
  let finishRest;
  service.call = async (operation, input) => {
    if (operation === 'recognize') return { text: '有什么服务？' };
    spoken.push(input.text);
    if (spoken.length === 2) await new Promise(resolve => { finishRest = resolve; });
    return audio();
  };
  const model = { respond: async (input, delta) => {
    assert.equal(input.voiceMode, true);
    delta('我可以帮你了解产品服务，'); await tick(); delta('也可以安排进一步的咨询。');
    return { text: '我可以帮你了解产品服务，也可以安排进一步的咨询。', model: 'gpt-6-luna' };
  } };
  const pending = service.streamTurn({ audioBase64: audio().audioBase64 }, model, event => events.push(event));
  await tick(); await tick();
  assert.equal(events.filter(event => event.type === 'audio').length, 1);
  assert.equal(events.some(event => event.type === 'done'), false);
  finishRest(); await pending;
  assert.equal(spoken.join(''), '我可以帮你了解产品服务，也可以安排进一步的咨询。');
  assert.deepEqual(events.filter(event => event.type === 'audio').map(event => event.index), [0, 1]);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).replyText, spoken.join(''));
});

test('model failure after a sentence cancels synthesis and never publishes unverified audio', async () => {
  const service = new LocalVoiceService(process.cwd()), events = [];
  service.call = async operation => operation === 'recognize' ? { text: '你好' } : audio();
  const model = { respond: async (input, delta) => { delta('我可以帮你了解产品服务，'); await tick(); throw new Error('model failed'); } };
  await assert.rejects(service.streamTurn({ audioBase64: audio().audioBase64 }, model, event => events.push(event)), /model failed/);
  assert.equal(events.some(event => ['audio', 'done'].includes(event.type)), false);
});

test('interrupting streamed synthesis drops queued chunks and prevents later speech', async () => {
  const service = new LocalVoiceService(process.cwd()), events = [], controller = new AbortController();
  service.call = async operation => operation === 'recognize' ? { text: '你好' } : audio();
  const model = { respond: async (input, delta) => { delta('我可以帮你了解产品服务，'); controller.abort(); return { text: '我可以帮你了解产品服务。' }; } };
  await assert.rejects(service.streamTurn({ audioBase64: audio().audioBase64 }, model, event => events.push(event), controller.signal), error => error.name === 'AbortError');
  assert.equal(events.some(event => ['audio', 'done'].includes(event.type)), false);
});

test('browser plays ordered chunks as they arrive and discards later chunks on interruption', async t => {
  const speaker = new EventTarget(), played = [], states = [];
  speaker.pause = () => {}; speaker.play = async () => { played.push(speaker.src); };
  const conversation = new LocalConversation({ audio: speaker, onStatus: text => states.push(text), onAudio: async () => {}, onMessage: () => {}, onError: message => { throw new Error(message); } });
  Object.assign(conversation, { connected: true, context: { sampleRate: 16000 }, settings: {} });
  let stream;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const event = value => stream.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  const pending = conversation.answer([new Float32Array(16000)]); await tick();
  event({ type: 'recognized', userText: '你好' }); event({ type: 'audio', index: 0, ...audio() }); await tick();
  assert.equal(played.length, 1);
  event({ type: 'audio', index: 1, ...audio() }); await tick(); assert.equal(played.length, 1);
  speaker.dispatchEvent(new Event('ended')); await tick(); assert.equal(played.length, 2);
  conversation.interrupt(false);
  event({ type: 'audio', index: 2, ...audio() }); event({ type: 'done', heard: true, userText: '你好', replyText: '完整回答' }); stream.close(); await pending;
  assert.equal(played.length, 2); assert.equal(conversation.history.some(item => item.role === 'assistant'), false);
  URL.revokeObjectURL(conversation.audioUrl);
});

test('HTTP speech stream emits audio before completion and protects account access', async t => {
  let sharing = true;
  const service = new LocalVoiceService(process.cwd());
  service.call = async operation => operation === 'recognize' ? { text: '你好' } : audio(); service.close = () => {};
  const chatgpt = { publicSession: async () => ({ sharing }), cancelSignIn: () => {}, respond: async (input, delta) => {
    delta('我可以帮你了解产品服务，'); delta('也可以安排进一步咨询。'); return { text: '我可以帮你了解产品服务，也可以安排进一步咨询。' };
  } };
  const server = createServer({ localVoice: service, chatgpt }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(base + '/api/local-voice/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioBase64: audio().audioBase64 }) });
  sharing = false; assert.equal((await post()).status, 401); sharing = true;
  const result = await post(); assert.equal(result.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const events = (await result.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'recognized'); assert.equal(events[1].type, 'audio'); assert.equal(events.at(-1).type, 'done');
});

test('interrupting recognition with a full history still allows the next turn', async t => {
  const speaker = new EventTarget(); speaker.pause = () => {};
  const conversation = new LocalConversation({ audio: speaker, onStatus: () => {}, onMessage: () => {}, onError: () => {} });
  Object.assign(conversation, { connected: true, context: { sampleRate: 16000 }, settings: {}, history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '旧'.repeat(2000) })) });
  let stream;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const pending = conversation.answer([new Float32Array(16000)]); await tick();
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'recognized', userText: '新'.repeat(12000) }) + '\n')); await tick();
  conversation.interrupt(false); stream.close(); await pending;
  assert.ok(conversation.history.length <= 20);
  assert.ok(conversation.history.reduce((sum, item) => sum + item.text.length, 0) <= 48000);
  assert.doesNotThrow(() => validateVoiceTurn({ audioBase64: audio().audioBase64, history: conversation.history }));
});
