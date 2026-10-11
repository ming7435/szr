import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeFrame, decodeFrame } from '../doubao-protocol.mjs';
import { DoubaoService } from '../doubao-service.mjs';
import { createWindowsEncryption } from '../windows-encryption.mjs';
import { createServer } from '../server.mjs';

const settings = { appId: '123456789', accessToken: 'private-doubao-token', voiceId: 'S_my_uploaded_voice', ownVoiceConfirmed: true };
const temporary = async t => { const root = await mkdtemp(path.join(os.tmpdir(), 'avatar-doubao-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const memoryEncryption = { id: 'test-only', encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() };

test('binary protocol matches official start connection bytes and rejects malformed lengths', () => {
  assert.deepEqual([...encodeFrame(1, {})], [17, 20, 16, 0, 0, 0, 0, 1, 0, 0, 0, 2, 123, 125]);
  const request = encodeFrame(100, { dialog: { extra: { model: '2.2.0.0' } } }, 'session');
  assert.equal(decodeFrame(request).sessionId, 'session'); assert.equal(decodeFrame(request).payload.dialog.extra.model, '2.2.0.0');
  const pcm = Buffer.from([0, 1, 2, 3]); assert.deepEqual(decodeFrame(encodeFrame(352, pcm, 'session', 11)).payload, pcm);
  for (const broken of [Buffer.from([17]), request.subarray(0, -1), Buffer.concat([request, Buffer.from([0])])]) assert.throws(() => decodeFrame(broken));
});

test('private Doubao settings require confirmed cloned voice and never expose the token', async t => {
  const root = await temporary(t), service = new DoubaoService(root, { encryption: createWindowsEncryption() });
  t.after(() => service.close());
  await assert.rejects(service.saveSettings({ ...settings, ownVoiceConfirmed: false }));
  await assert.rejects(service.saveSettings({ ...settings, voiceId: 'vv' }));
  await service.saveSettings(settings);
  const status = await service.publicConfig(); assert.equal(status.configured, true); assert.equal(status.voice, 'uploaded-reference');
  assert.equal(JSON.stringify(status).includes(settings.accessToken), false);
  assert.equal((await readFile(path.join(root, '.private/doubao/settings.json'), 'utf8')).includes(settings.accessToken), false);
});

test('real local websocket bridge streams audio and rejects late old reply after interruption', async t => {
  const root = await temporary(t), upstreamServer = http.createServer(), upstream = new WebSocketServer({ server: upstreamServer });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  let cloud, sessionId, receivedAudio, sessionConfig;
  upstream.on('connection', (socket, request) => {
    assert.equal(request.headers['x-api-access-key'], settings.accessToken); cloud = socket;
    socket.on('message', bytes => {
      const event = decodeFrame(bytes);
      if (event.event === 1) socket.send(encodeFrame(50, {}, 'connection', 9));
      if (event.event === 100) { sessionId = event.sessionId; sessionConfig = event.payload; socket.send(encodeFrame(150, { dialog_id: 'dialog' }, sessionId, 9)); }
      if (event.event === 200) receivedAudio = event.payload;
      if (event.event === 102) socket.send(encodeFrame(152, {}, sessionId, 9));
    });
  });
  const service = new DoubaoService(root, { encryption: memoryEncryption, upstreamURL: `ws://127.0.0.1:${upstreamServer.address().port}` });
  await service.saveSettings(settings); const server = http.createServer(); service.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.close(); for (const socket of upstream.clients) socket.terminate(); upstream.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstreamServer.close(resolve))]); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new WebSocket(origin.replace('http', 'ws') + '/api/doubao/live', { origin });
  const messages = []; client.on('message', (bytes, binary) => messages.push(binary ? { audio: bytes } : JSON.parse(bytes.toString())));
  await once(client, 'open'); client.send(JSON.stringify({ type: 'start', instructions: '你的名字是李云龙。中文回答', voice: 'vv' }));
  await new Promise(resolve => { const wait = () => messages.some(event => event.type === 'ready') ? resolve() : setTimeout(wait, 5); wait(); });
  assert.equal(sessionConfig.tts.speaker, settings.voiceId); assert.equal(sessionConfig.dialog.extra.model, '2.2.0.0');
  assert.match(sessionConfig.dialog.character_manifest, /^你是一位景区讲解员/);
  assert.ok(!sessionConfig.dialog.character_manifest.includes('李云龙'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('不要自称豆包'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('中文回答'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('自然、清晰、利落'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('不故意拖长元音'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('不要撒娇'));
  assert.ok(sessionConfig.dialog.character_manifest.indexOf('发声要求')>sessionConfig.dialog.character_manifest.indexOf('中文回答'));
  assert.equal(sessionConfig.dialog.speaking_style,undefined,'SC2.0 uses character_manifest for delivery style');
  assert.equal(sessionConfig.tts.audio_config.format, 'pcm_s16le');
  assert.deepEqual(sessionConfig.tts.extra, {});
  const input = Buffer.from([0, 1, 2, 3]); client.send(input); await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(receivedAudio, input);
  cloud.send(encodeFrame(350, { reply_id: 'old', question_id: 'q1' }, sessionId, 9)); cloud.send(encodeFrame(352, input, sessionId, 11));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(messages.filter(event => event.audio).length, 1);
  client.send(JSON.stringify({ type: 'interrupt', replyId: 'old', questionId: 'q1', audioEndMs: 20 })); await new Promise(resolve => setTimeout(resolve, 20));
  cloud.send(encodeFrame(352, input, sessionId, 11)); cloud.send(encodeFrame(350, { reply_id: 'old' }, sessionId, 9)); cloud.send(encodeFrame(352, input, sessionId, 11));
  cloud.send(encodeFrame(450, { question_id: 'q2' }, sessionId, 9)); await new Promise(resolve => setTimeout(resolve, 20));
  // Local interruption of q1 may reach the proxy after cloud ASR has already started q2.
  client.send(JSON.stringify({ type: 'interrupt', replyId: 'old', questionId: 'q1', audioEndMs: 20 })); await new Promise(resolve => setTimeout(resolve, 20));
  cloud.send(encodeFrame(350, { reply_id: 'new', question_id: 'q2' }, sessionId, 9)); cloud.send(encodeFrame(352, input, sessionId, 11));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(messages.filter(event => event.audio).length, 2);
  assert.equal(messages.filter(event => event.type === 'response_started').at(-1).replyId, 'new');
  cloud.send(encodeFrame(450, { question_id: 'q3' }, sessionId, 9)); await new Promise(resolve => setTimeout(resolve, 20));
  client.send(JSON.stringify({ type: 'interrupt', questionId: 'q3', audioEndMs: 0 })); await new Promise(resolve => setTimeout(resolve, 20));
  cloud.send(encodeFrame(450, { question_id: 'q4' }, sessionId, 9));
  cloud.send(encodeFrame(350, { reply_id: 'unseen-old', question_id: 'q3' }, sessionId, 9)); cloud.send(encodeFrame(352, input, sessionId, 11));
  cloud.send(encodeFrame(350, { reply_id: 'fresh', question_id: 'q4' }, sessionId, 9)); cloud.send(encodeFrame(352, input, sessionId, 11));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(messages.filter(event => event.audio).length, 3);
  client.close(); await once(client, 'close');
});

test('new console API Key uses private header authentication without an APP ID', async t => {
  const root = await temporary(t), upstreamServer = http.createServer(), upstream = new WebSocketServer({ server: upstreamServer });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const service = new DoubaoService(root, { encryption: createWindowsEncryption(), upstreamURL: `ws://127.0.0.1:${upstreamServer.address().port}` });
  const apiKey = 'new-console-test-private-key';
  await service.saveSettings({ authMode: 'api-key', apiKey, voiceId: settings.voiceId, ownVoiceConfirmed: true });
  const safe = await service.publicConfig(); assert.equal(safe.authMode, 'api-key'); assert.equal(JSON.stringify(safe).includes(apiKey), false);
  assert.equal((await readFile(service.filename, 'utf8')).includes(apiKey), false);
  const server = http.createServer(); service.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.close(); for (const socket of upstream.clients) socket.terminate(); upstream.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstreamServer.close(resolve))]); });
  let sessionConfig;
  upstream.on('connection', socket => socket.on('message', bytes => {
    const event = decodeFrame(bytes);
    if (event.event === 1) socket.send(encodeFrame(50, {}, 'connection', 9));
    if (event.event === 100) { sessionConfig = event.payload; socket.send(encodeFrame(150, {}, event.sessionId, 9)); }
    if (event.event === 102) socket.send(encodeFrame(152, {}, event.sessionId, 9));
  }));
  const connection = once(upstream, 'connection');
  const origin = `http://127.0.0.1:${server.address().port}`, client = new WebSocket(origin.replace('http', 'ws') + '/api/doubao/live', { origin });
  await once(client, 'open'); client.send(JSON.stringify({ type: 'start' }));
  const [, request] = await connection;
  assert.equal(request.headers['x-api-key'], apiKey); assert.equal(request.headers['x-api-app-id'], undefined); assert.equal(request.headers['x-api-access-key'], undefined);
  await new Promise(resolve => { const wait = () => sessionConfig ? resolve() : setTimeout(wait, 5); wait(); });
  assert.match(sessionConfig.dialog.character_manifest, /^你是一位景区讲解员/);
  assert.ok(!sessionConfig.dialog.character_manifest.includes('李云龙'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('不要自称豆包'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('自然、清晰、利落'));
  assert.ok(sessionConfig.dialog.character_manifest.includes('不故意拖长元音'));
  client.close(); await once(client, 'close');
});

test('foreign websocket origin is rejected before cloud connection', async t => {
  const root = await temporary(t), service = new DoubaoService(root, { encryption: memoryEncryption });
  const server = http.createServer(); service.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.close(); await new Promise(resolve => server.close(resolve)); });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/doubao/live`, { origin: 'https://foreign.test' });
  const [error] = await once(client, 'error'); assert.match(error.message, /403/);
});

test('HTTP setup protects secrets, enforces same origin and persists only the cloned voice', async t => {
  const root = await temporary(t), service = new DoubaoService(root, { encryption: createWindowsEncryption() });
  const server = createServer({ dataRoot: root, doubao: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = origin => fetch(base + '/api/doubao/settings', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal((await save('https://foreign.test')).status, 403);
  const saved = await save(base); assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(settings.accessToken), false);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.doubao.configured, true); assert.equal(config.doubao.voiceId, settings.voiceId);
  assert.equal(JSON.stringify(config).includes(settings.accessToken), false);
  assert.equal((await fetch(base + '/.private/doubao/settings.json')).status, 404);
});
