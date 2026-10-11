import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { ChatGPTService } from '../chatgpt-service.mjs';
import { createWindowsEncryption } from '../windows-encryption.mjs';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'avatar-pro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256';
  const encryption = createWindowsEncryption();
  let pending, refreshes = 0, failed = false;
  const flags = { wrongNonce: false, revocationStatus: 200, foreignRevocation: false };
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: flags.foreignRevocation ? 'https://other.test/revoke' : 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (String(url).endsWith('/oauth/revoke')) return new Response(null, { status: flags.revocationStatus });
    if (String(url).endsWith('jwks.json')) return Response.json({ keys: [jwk] });
    if (String(url).endsWith('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_id'), 'oaiapp_test');
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      if (form.get('grant_type') === 'refresh_token') { refreshes++; assert.equal(form.get('refresh_token'), 'private-refresh'); }
      else { assert.equal(form.get('code'), 'private-code'); assert.ok(form.get('code_verifier')); }
      const token = await new SignJWT({ nonce: form.get('grant_type') === 'refresh_token' ? undefined : flags.wrongNonce ? 'wrong-nonce' : pending.searchParams.get('nonce'), name: '本地测试', email: 'local@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject('test-user').setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', id_token: token, token_type: 'Bearer', expires_in: refreshes ? 3600 : 30, scope: 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    if (String(url).endsWith('/models')) { assert.equal(init.headers.authorization, 'Bearer private-access'); return Response.json({ models: [{ slug: 'available-model', display_name: '可用模型', visibility: 'list' }] }); }
    if (String(url).endsWith('/responses')) {
      const body = JSON.parse(init.body); assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(Array.isArray(body.input)); assert.equal(body.model, 'available-model');
      const events = [{ type: 'response.output_text.delta', delta: '你好，' }, { type: 'response.output_text.delta', delta: '我收到你的问题了。' }, failed ? { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-access should never leak' } } } : { type: 'response.completed' }];
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error('unexpected request');
  };
  const service = new ChatGPTService(root, { fetch: fetcher, encryption });
  t.after(() => service.cancelSignIn());
  async function signIn(expectInvalidIdentity = false) {
    const result = await service.startSignIn('http://127.0.0.1:4173'); pending = new URL(result.authorizationUrl);
    const callback = new URL(pending.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', pending.searchParams.get('state')); callback.searchParams.set('code', 'private-code'); callback.searchParams.set('client_id', 'oaiapp_test');
    const wrong = new URL(callback); wrong.searchParams.set('state', 'wrong-state');
    assert.equal((await fetch(wrong)).status, 400);
    assert.equal((await fetch(callback)).status, expectInvalidIdentity ? 400 : 200);
    if (expectInvalidIdentity) await assert.rejects(() => service.waitForSignIn(), error => error.code === 'invalid_id_token');
    else await assert.doesNotReject(() => service.waitForSignIn());
  }
  return { root, service, signIn, requests, flags, get refreshes() { return refreshes; }, set failed(value) { failed = value; } };
}

test('a signed identity with the wrong nonce cannot enable plan usage', async t => {
  const f = await fixture(t); f.flags.wrongNonce = true; await f.signIn(true);
  const session = await f.service.publicSession(); assert.equal(session.sharing, false); assert.equal(session.code, 'invalid_id_token');
});

test('concurrent sign-in attempts are rejected and cancellation closes the callback', async t => {
  const f = await fixture(t); const starting = f.service.startSignIn('http://127.0.0.1:4173');
  await assert.rejects(() => f.service.startSignIn('http://127.0.0.1:4173'), error => error.code === 'connection_busy');
  const result = await starting; const callback = new URL(new URL(result.authorizationUrl).searchParams.get('redirect_uri'));
  f.service.cancelSignIn(); await assert.rejects(() => f.service.waitForSignIn(), error => error.code === 'cancelled');
  await assert.rejects(() => fetch(callback));
  assert.equal((await f.service.publicSession()).sharing, false);
});

test('an explicit sign-in preserves unreadable credentials and replaces them with a verified identity', async t => {
  const f = await fixture(t); await f.service.publicSession();
  const directory = path.join(f.root, '.private/chatgpt');
  const damaged = Buffer.alloc(128);
  await writeFile(path.join(directory, 'connection.json'), damaged);
  assert.equal((await f.service.publicSession()).code, 'storage_error');
  await f.signIn(); assert.equal((await f.service.publicSession()).sharing, true);
  const backup = (await readdir(directory)).find(name => name.startsWith('connection.unreadable.'));
  assert.ok(backup); assert.deepEqual(await readFile(path.join(directory, backup)), damaged);
  const saved = await readFile(path.join(directory, 'connection.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(saved));
  assert.equal(saved.includes('private-access'), false);
});

test('official OAuth rejects wrong state, verifies identity, encrypts credentials and reuses host across restarts', async t => {
  const f = await fixture(t); await f.signIn();
  const session = await f.service.publicSession(); assert.equal(session.sharing, true); assert.equal(session.identity.email, 'local@example.test');
  const serialized = JSON.stringify(session); assert.equal(serialized.includes('private-access'), false); assert.equal(serialized.includes('private-refresh'), false);
  const saved = await readFile(path.join(f.root, '.private/chatgpt/connection.json'), 'utf8');
  assert.equal(saved.includes('private-access'), false); assert.equal(saved.includes('private-refresh'), false);
  const hostBefore = await readFile(path.join(f.root, '.private/chatgpt/host.json'), 'utf8');
  const restarted = new ChatGPTService(f.root, { encryption: createWindowsEncryption() }); t.after(() => restarted.cancelSignIn());
  assert.equal((await restarted.publicSession()).sharing, true);
  const next = await restarted.startSignIn('http://127.0.0.1:4173'); const auth = new URL(next.authorizationUrl);
  assert.equal(auth.searchParams.get('client_id'), 'oaiapp_test'); assert.equal(auth.searchParams.get('ext_agent_host_id'), JSON.parse(hostBefore).hostId);
});

test('concurrent model requests refresh once and a completed response keeps history without leaking tokens', async t => {
  const f = await fixture(t); await f.signIn();
  await Promise.all([f.service.models(), f.service.models()]); assert.equal(f.refreshes, 1);
  const deltas = []; const result = await f.service.respond({ model: 'available-model', messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好。' }, { role: 'user', text: '继续聊' }], instructions: '中文回答' }, delta => deltas.push(delta));
  assert.equal(result.text, '你好，我收到你的问题了。'); assert.equal(deltas.join(''), result.text);
  const request = f.requests.find(item => item.url.endsWith('/responses')); assert.equal(JSON.parse(request.init.body).input.length, 3);
  f.failed = true;
  await assert.rejects(() => f.service.respond({ messages: [{ role: 'user', text: '你好' }] }, () => {}), e => e.code === 'subscription_sharing_usage_limit_exceeded' && !e.message.includes('private-access'));
  await assert.rejects(() => f.service.respond({ messages: [{ role: 'system', text: '坏角色' }] }, () => {}), e => e.status === 400);
});

test('local chat HTTP routes guard origin, expose safe status and return streamed replies', async t => {
  const f = await fixture(t); await f.signIn();
  const server = createServer({ chatgpt: f.service, dataRoot: f.root }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: '你好' }] }) });
  assert.equal(result.status, 200); const events = (await result.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).text, '你好，我收到你的问题了。');
  assert.equal((await fetch(base + '/api/chatgpt/session')).status, 200);
  assert.equal((await fetch(base + '/api/chatgpt/signin', { method: 'POST', headers: { origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(base + '/.private/chatgpt/connection.json')).status, 404);
});

test('removing an unused membership connection revokes its session and forgets all saved login files', async t => {
  const f = await fixture(t); await f.signIn();
  const directory = path.join(f.root, '.private/chatgpt');
  await writeFile(path.join(directory, 'connection.unreadable.0fa97cbb-a044-454c-9c0d-257106ec020d.json'), 'obsolete login');
  await writeFile(path.join(f.root, '.private/doubao-preserve'), 'current voice configuration');
  const result = await f.service.removeConnection();
  assert.equal(result.remoteRevocation, 'confirmed');
  const revoke = f.requests.find(request => request.url.endsWith('/oauth/revoke'));
  assert.equal(revoke.init.method, 'POST');
  const form = new URLSearchParams(revoke.init.body);
  assert.equal(form.get('token'), 'private-refresh'); assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), 'oaiapp_test');
  assert.equal((await readdir(directory)).length, 0);
  assert.equal(await readFile(path.join(f.root, '.private/doubao-preserve'), 'utf8'), 'current voice configuration');
  const restarted = new ChatGPTService(f.root); const session = await restarted.publicSession();
  assert.equal(session.status, 'disconnected'); assert.equal(session.sharing, false); assert.equal(session.identity, null);
  await assert.rejects(() => restarted.accessToken(), error => error.code === 'sign_in_required');
  assert.equal(JSON.stringify(result).includes('private-refresh'), false);
});

test('failed remote revocation is reported honestly while local membership access is removed', async t => {
  const f = await fixture(t); await f.signIn(); f.flags.revocationStatus = 503;
  const result = await f.service.removeConnection();
  assert.equal(result.remoteRevocation, 'unconfirmed');
  assert.equal(f.requests.filter(request => request.url.endsWith('/oauth/revoke')).length, 3);
  assert.equal((await f.service.publicSession()).sharing, false);
  assert.equal((await readdir(path.join(f.root, '.private/chatgpt'))).length, 0);
});

test('membership removal never sends a saved token to a foreign revocation endpoint', async t => {
  const f = await fixture(t); await f.signIn(); f.flags.foreignRevocation = true; f.service.discoveryPromise = null;
  const result = await f.service.removeConnection();
  assert.equal(result.remoteRevocation, 'unconfirmed');
  assert.equal(f.requests.some(request => request.url.startsWith('https://other.test')), false);
  assert.equal((await f.service.publicSession()).sharing, false);
});
