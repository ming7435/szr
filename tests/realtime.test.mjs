import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.mjs';

async function withServer(options, action) {
  const server = createServer(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (base, route, value) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('config reports missing credentials without exposing private configuration', async () => {
  await withServer({ config: { apiKey: '', model: 'gpt-realtime-2.1-mini' } }, async base => {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.apiConfigured, false); assert.equal(config.model, 'gpt-realtime-2.1-mini'); assert.equal(config.customVoiceId, null);
    assert.equal((await post(base, '/api/session', { sdp: 'v=0\r\n' })).status, 503);
  });
  await withServer({ config: { apiKey: 'test-private-server-key', model: 'gpt-realtime-2.1-mini' } }, async base => {
    const config = await (await fetch(base + '/api/config')).text();
    assert.ok(!config.includes('test-private-server-key')); assert.equal(JSON.parse(config).apiConfigured, true);
    assert.equal((await fetch(base + '/.env.local')).status, 404);
  });
});

test('requesting an uncreated custom voice never silently uses a built-in voice', async () => {
  await withServer({ config: { apiKey: 'local-test', model: 'gpt-realtime-2.1-mini', customVoiceId: '' } }, async base => {
    const result = await post(base, '/api/session', { sdp: 'v=0\r\n' });
    assert.equal(result.status, 409); assert.match((await result.json()).error, /专属音色/);
  });
});

test('fixed avatar voice rejects built-in voices and client-provided voice IDs', async () => {
  await withServer({ config: { apiKey: 'local-test', customVoiceId: 'voice_local_test', baseUrl: 'http://127.0.0.1:1/v1' } }, async base => {
    for (const voice of ['cedar', 'marin', { id: 'voice_another_person' }]) {
      const response = await post(base, '/api/session', { sdp: 'v=0\r\n', voice });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /固定/);
    }
  });
});

test('unified call sends exact model, custom voice, Mandarin transcription and interruptible semantic VAD', async () => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://local.test', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) });
    const form = await request.formData(); received = { pathname: req.url, auth: req.headers.authorization, sdp: form.get('sdp'), session: JSON.parse(form.get('session')) };
    res.writeHead(201, { 'content-type': 'application/sdp' }); res.end('v=0\r\ns=local-answer\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await withServer({ config: { apiKey: 'local-test', model: 'gpt-realtime-2.1-mini', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, customVoiceId: 'voice_local_test' } }, async base => {
      const result = await post(base, '/api/session', { sdp: 'v=0\r\ns=local-offer\r\n', instructions: '说中文。', eagerness: 'low' });
      assert.equal(result.status, 200); assert.equal((await result.json()).sdp, 'v=0\r\ns=local-answer\r\n');
    });
    assert.equal(received.pathname, '/v1/realtime/calls'); assert.equal(received.auth, 'Bearer local-test'); assert.equal(received.sdp, 'v=0\r\ns=local-offer\r\n');
    assert.equal(received.session.model, 'gpt-realtime-2.1-mini'); assert.deepEqual(received.session.audio.output.voice, { id: 'voice_local_test' });
    assert.equal(received.session.audio.input.transcription.language, 'zh');
    assert.deepEqual(received.session.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});

test('upstream failures return actionable errors without key contents', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'some upstream detail', code: 'invalid_api_key' } })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await withServer({ config: { apiKey: 'local-secret', customVoiceId: 'voice_local_test', model: 'gpt-realtime-2.1-mini', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` } }, async base => {
      const response = await post(base, '/api/session', { sdp: 'v=0\r\n' }); assert.equal(response.status, 401);
      const text = await response.text(); assert.ok(!text.includes('local-secret')); assert.match(text, /API Key/);
    });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});

test('cross-site session requests are rejected', async () => {
  await withServer({ config: { apiKey: '' } }, async base => {
    const response = await fetch(base + '/api/session', { method: 'POST', headers: { origin: 'https://unrelated.test', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  });
});

test('foreign Host names cannot read the local app or invoke the API', async () => {
  await withServer({ config: { apiKey: '' } }, async base => {
    const status = await new Promise((resolve, reject) => { const request = http.get(base + '/api/config', { headers: { host: 'foreign.test', origin: 'http://foreign.test' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(status, 403);
  });
});
