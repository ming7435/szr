import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SimliService } from '../simli-service.mjs';
import { createWindowsEncryption } from '../windows-encryption.mjs';
import { createServer } from '../server.mjs';

const faceId = '16a939c3-1552-4cd3-b0d1-2d116d8a11d0';
const apiKey = 'private-simli-test-credential';
const temporary = async t => { const root = await mkdtemp(path.join(os.tmpdir(), 'avatar-simli-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const encryption = { id: 'test-only', encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('Simli key is encrypted; model is required to enable video; blank key preserves saved credential', async t => {
  const service = new SimliService(await temporary(t), { encryption: createWindowsEncryption() });
  await service.saveSettings({ apiKey, enabled: false });
  const pending = await service.publicConfig();
  assert.equal(pending.credentialConfigured, true); assert.equal(pending.configured, false); assert.equal(pending.enabled, false);
  await assert.rejects(service.saveSettings({ faceId, enabled: true, ownPortraitConfirmed: false }));
  await service.saveSettings({ faceId, enabled: true, ownPortraitConfirmed: true });
  assert.equal((await service.publicConfig()).configured, true);
  assert.equal((await service.read()).apiKey, apiKey);
  assert.equal(JSON.stringify(await service.publicConfig()).includes(apiKey), false);
  assert.equal((await readFile(service.filename, 'utf8')).includes(apiKey), false);
});

test('session fixes the confirmed face and uses backend key only in provider headers', async t => {
  const calls = [];
  const service = new SimliService(await temporary(t), { encryption, fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers['x-simli-api-key'], apiKey);
    if (url.endsWith('/faces')) return json([{ id: faceId, simli_version: 2 }]);
    if (url.endsWith('/compose/ice')) return json([{ urls: ['stun:stun.example.org'] }]);
    if (url.endsWith('/compose/token')) return json({ session_token: 'temporary-session-token' });
    throw new Error('Unexpected endpoint');
  } });
  await service.saveSettings({ apiKey, faceId, enabled: true, ownPortraitConfirmed: true });
  const session = await service.session();
  assert.equal(session.sessionToken, 'temporary-session-token');
  assert.equal(session.sampleRate, 16000); assert.equal(session.maxSessionLength, 900);
  assert.equal(JSON.stringify(session).includes(apiKey), false);
  const payload = JSON.parse(calls.find(call => call.url.endsWith('/compose/token')).options.body);
  assert.equal(payload.faceId, faceId); assert.equal(payload.apiVersion, 'v2'); assert.equal(payload.audioInputFormat, 'pcm16');
  assert.equal(payload.handleSilence, true); assert.equal(payload.maxSessionLength, 900);
});

test('missing avatar fails before creating a billable session; provider errors do not disclose secrets', async t => {
  let tokenCalls = 0, status = 200;
  const service = new SimliService(await temporary(t), { encryption, fetch: async url => {
    if (url.endsWith('/compose/token')) tokenCalls++;
    return json(status === 200 ? [] : { detail: apiKey }, status);
  } });
  await service.saveSettings({ apiKey, faceId, enabled: true, ownPortraitConfirmed: true });
  await assert.rejects(service.session(), /人像/); assert.equal(tokenCalls, 0);
  status = 401; await assert.rejects(service.listFaces(), error => error.status === 401 && !error.message.includes(apiKey));
  status = 402; await assert.rejects(service.listFaces(), error => error.status === 402 && /额度/.test(error.message));
});

test('local APIs redact credentials, reject foreign origin and do not serve private files', async t => {
  const root = await temporary(t), simli = new SimliService(root, { encryption, fetch: async () => json([]) });
  const server = createServer({ dataRoot: root, simli, localVoice: { publicStatus: async () => ({}), close() {} }, chatgpt: { publicSession: async () => ({}), cancelSignIn() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const input = { apiKey, enabled: false };
  assert.equal((await fetch(base + '/api/simli/settings', { method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const result = await fetch(base + '/api/simli/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(result.status, 200); assert.equal((await result.text()).includes(apiKey), false);
  const config = await (await fetch(base + '/api/config')).json(); assert.equal(config.simli.credentialConfigured, true); assert.equal(JSON.stringify(config).includes(apiKey), false);
  assert.equal((await fetch(base + '/.private/simli/settings.json')).status, 404);
  assert.equal((await fetch(base + '/api/simli/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
});
