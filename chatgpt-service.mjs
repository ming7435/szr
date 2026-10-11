import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createWindowsEncryption } from './windows-encryption.mjs';

const ISSUER = 'https://auth.openai.com', RESOURCE = 'https://api.openai.com/v1';
const errors = {
  sign_in_required: '请先使用 ChatGPT 登录，再发送消息。',
  sharing_not_enabled: '登录已完成，但尚未授权使用 ChatGPT 套餐。请重新登录并开启套餐使用权限。',
  access_denied: '本次登录授权未完成，可以重新登录。',
  connection_busy: '登录正在进行，请完成浏览器里的授权，或先取消登录。',
  invalid_grant: '登录凭证已过期，请重新登录。',
  invalid_token: '登录凭证未被接受，请重新登录。',
  account_mismatch: '登录账号与原连接不一致，请退出后重新连接。',
  invalid_id_token: '登录身份校验未通过，请重新登录。',
  storage_error: '本机登录资料无法读取，原文件已保留。',
  network_error: '无法连接 OpenAI，请检查本机网络后重试。',
  model_not_found: '当前账号无法使用这个模型，请重新选择可用模型。',
  subscription_sharing_user_not_eligible: '当前账号或工作区暂不支持在此应用使用 ChatGPT 套餐。',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 套餐使用额度已达到限制，请到用量设置查看。',
  subscription_sharing_usage_unavailable: 'ChatGPT 暂时无法确认可用额度，请稍后重试。',
  subscription_sharing_route_not_supported: '当前账号暂不支持这个应用的对话接口。',
  subscription_sharing_unsupported_capability: '当前套餐连接暂不支持这项能力。',
  stream_interrupted: '连接中断，回答未完成。请重新发送消息。',
  response_incomplete: '回答尚未完成，请重新发送消息。',
  cancelled: '已取消本次操作。',
  timeout: '登录等待超时，请重新登录。',
};
export function safeChatError(error) {
  const code = Object.hasOwn(errors, error?.code) ? error.code : 'connection_error';
  return { code, error: errors[code] || '本次连接未完成，请稍后重试。' };
}
function failure(code, status = 400) { return Object.assign(new Error(errors[code] || '本次连接未完成，请稍后重试。'), { code, status }); }
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
function string(value, limit) { return typeof value === 'string' && value.length <= limit ? value : ''; }

export class ChatGPTService {
  constructor(root, options = {}) {
    this.directory = path.join(root, '.private', 'chatgpt');
    this.filename = path.join(this.directory, 'connection.json');
    this.fetch = options.fetch || globalThis.fetch;
    this.encryption = options.encryption || createWindowsEncryption();
    this.queue = Promise.resolve(); this.modelCache = null; this.pending = null; this.lastError = null;
  }
  async remote(url, init = {}) {
    try { return await this.fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
    catch (error) { if (init.signal?.aborted) throw failure('cancelled'); throw failure('network_error', 502); }
  }
  async checkedJSON(response) {
    let data; try { data = await response.json(); } catch { throw failure('network_error', 502); }
    if (!response.ok) {
      const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
      throw failure(Object.hasOwn(errors, code) ? code : response.status === 401 ? 'invalid_token' : 'network_error', response.status);
    }
    return data;
  }
  async discovery() {
    this.discoveryPromise ??= (async () => {
      const config = await this.checkedJSON(await this.remote(ISSUER + '/.well-known/openid-configuration'));
      if (config.issuer !== ISSUER) throw failure('invalid_id_token');
      for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        const url = new URL(config[name]); if (url.origin !== ISSUER || url.username || url.password) throw failure('invalid_id_token');
      }
      return config;
    })().catch(error => { this.discoveryPromise = null; throw error; });
    return this.discoveryPromise;
  }
  async locked(operation) {
    const job = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const release = await lockfile.lock(path.join(this.directory, 'credentials'), { realpath: false, stale: 120000, update: 30000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
      try { return await operation(); } finally { await release(); }
    });
    this.queue = job.catch(() => {}); return job;
  }
  async read() {
    let json;
    try { json = await readFile(this.filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw failure('storage_error'); }
    try {
      const envelope = JSON.parse(json);
      if (envelope.version !== 1 || envelope.provider !== this.encryption.id || typeof envelope.ciphertext !== 'string') throw new Error();
      const record = JSON.parse(await this.encryption.decrypt(Buffer.from(envelope.ciphertext, 'base64')));
      if (!record.clientId || record.clientId === 'dynamic_agent_client' || !Array.isArray(record.scopes)) throw new Error();
      return record;
    } catch { throw failure('storage_error'); }
  }
  async save(record) {
    const ciphertext = await this.encryption.encrypt(JSON.stringify(record));
    const temporary = path.join(this.directory, 'connection.' + randomUUID() + '.tmp');
    try { await writeFile(temporary, JSON.stringify({ version: 1, provider: this.encryption.id, ciphertext: Buffer.from(ciphertext).toString('base64') }), { flag: 'wx', mode: 0o600, flush: true }); await rename(temporary, this.filename); }
    finally { await rm(temporary, { force: true }); }
  }
  async hostId() {
    const file = path.join(this.directory, 'host.json');
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (!/^urn:uuid:[a-f0-9-]{36}$/.test(saved.hostId)) throw failure('storage_error'); return saved.hostId; }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('storage_error');
      const hostId = 'urn:uuid:' + randomUUID(); await writeFile(file, JSON.stringify({ hostId }), { flag: 'wx', mode: 0o600, flush: true }); return hostId;
    }
  }
  async publicSession() {
    let record;
    try { record = await this.locked(() => this.read()); } catch (error) { return { status: 'reauth_required', sharing: false, ...safeChatError(error) }; }
    const sharing = !!(record?.credentials && record.scopes.includes('chatgpt.tokens.use.direct') && record.scopes.includes('resource.invoke'));
    return { status: this.pending || this.starting ? 'connecting' : record?.credentials ? 'connected' : 'disconnected', sharing, identity: record?.identity || null, verified: !!this.verified, ...(this.lastError ? safeChatError(this.lastError) : {}) };
  }
  async identity(idToken, clientId, nonce, subject) {
    const config = await this.discovery();
    this.jwks ??= createRemoteJWKSet(new URL(config.jwks_uri), { [customFetch]: (url, init) => this.remote(String(url), init) });
    let payload;
    try { ({ payload } = await jwtVerify(idToken, this.jwks, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'] })); }
    catch { throw failure('invalid_id_token'); }
    if (!payload.sub || (nonce !== undefined && !equal(payload.nonce, nonce))) throw failure('invalid_id_token');
    if (subject && payload.sub !== subject) throw failure('account_mismatch');
    return { subject: payload.sub, identity: { name: string(payload.name, 160), email: string(payload.email, 254) } };
  }
  credentials(data) {
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || typeof data.id_token !== 'string' || typeof data.scope !== 'string' || data.token_type?.toLowerCase() !== 'bearer') throw failure('invalid_token');
    return { accessToken: data.access_token, refreshToken: string(data.refresh_token, 32000), expiresAt: Date.now() + data.expires_in * 1000 };
  }
  async startSignIn(returnUrl) {
    if (this.pending || this.starting) throw failure('connection_busy', 409);
    this.starting = true;
    const generation = this.authGeneration || 0;
    try { return await this.beginSignIn(returnUrl, generation); }
    finally { this.starting = false; }
  }
  async beginSignIn(returnUrl, generation) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(returnUrl)) throw failure('invalid_token');
    const prepared = await this.locked(async () => {
      let previous;
      try { previous = await this.read(); }
      catch (error) {
        if (error.code !== 'storage_error') throw error;
        // Preserve unreadable data and let an explicit sign-in establish new credentials.
        await rename(this.filename, path.join(this.directory, 'connection.unreadable.' + randomUUID() + '.json'));
        previous = null;
      }
      return { previous, hostId: await this.hostId() };
    });
    if (this.pending) throw failure('connection_busy', 409);
    const config = await this.discovery();
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const abort = new AbortController();
    let resolveCallback, rejectCallback;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    // Attach immediately so cancellation cannot become an unhandled rejection.
    callback.catch(() => {});
    let accepted = false;
    const listener = http.createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      let url; try { url = new URL(request.url, 'http://127.0.0.1'); } catch { response.writeHead(400); return response.end(); }
      if (request.method !== 'GET' || url.pathname !== '/auth/callback' || request.headers.host !== `127.0.0.1:${listener.address().port}`) { response.writeHead(404); return response.end(); }
      if (!equal(url.searchParams.get('state'), state) || accepted) { response.writeHead(400); return response.end('Invalid sign-in state.'); }
      accepted = true;
      if (url.searchParams.has('error')) { response.writeHead(400); response.end('Sign-in was not completed.'); rejectCallback(failure('access_denied')); return; }
      const clientId = url.searchParams.get('client_id') || prepared.previous?.clientId;
      if (!/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId || '') || (prepared.previous && clientId !== prepared.previous.clientId) || !url.searchParams.get('code')) { response.writeHead(400); response.end('Incomplete sign-in.'); rejectCallback(failure('invalid_grant')); return; }
      resolveCallback({ clientId, code: url.searchParams.get('code') });
      try {
        await this.signInTask;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><meta charset="utf-8"><title>数字人登录完成</title><h1>登录已完成</h1><p>请返回数字人网页，开始语音对话。</p><a href="${returnUrl}/">返回数字人网页</a>`);
      } catch { response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); response.end('登录未完成，请返回数字人网页查看状态并重试。'); }
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    if (generation !== (this.authGeneration || 0)) { listener.close(); throw failure('cancelled'); }
    const redirectUri = `http://127.0.0.1:${listener.address().port}/auth/callback`;
    const timer = setTimeout(() => rejectCallback(failure('timeout')), 10 * 60 * 1000); timer.unref();
    this.pending = { abort, listener, rejectCallback }; this.lastError = null;
    this.signInTask = (async () => {
      try {
        const result = await callback;
        abort.signal.throwIfAborted();
        await this.locked(() => this.save(prepared.previous || { clientId: result.clientId, scopes: [], identity: null }));
        const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
        const data = await this.checkedJSON(await this.remote(config.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: abort.signal }));
        const credentials = this.credentials(data);
        const identity = await this.identity(data.id_token, result.clientId, nonce, prepared.previous?.subject);
        abort.signal.throwIfAborted();
        await this.locked(() => this.save({ clientId: result.clientId, ...identity, scopes: data.scope.split(/\s+/), idToken: data.id_token, credentials }));
        this.modelCache = null; this.verified = false;
        return true;
      } catch (error) { this.lastError = error?.name === 'AbortError' ? failure('cancelled') : error; throw this.lastError; }
      finally { clearTimeout(timer); this.pending = null; listener.close(); }
    })();
    this.signInTask.catch(() => {});
    const auth = new URL(config.authorization_endpoint);
    const parameters = { client_id: prepared.previous?.clientId || 'dynamic_agent_client', ext_agent_host_id: prepared.hostId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
    if (!prepared.previous) parameters.agent_name_hint = '映身数字人';
    // Do not put id_token_hint in URLs exposed to the browser; account selection remains explicit.
    for (const [key, value] of Object.entries(parameters)) auth.searchParams.set(key, value);
    return { authorizationUrl: auth.href };
  }
  waitForSignIn() { return this.signInTask || Promise.resolve(); }
  cancelSignIn() { this.authGeneration = (this.authGeneration || 0) + 1; if (this.pending) { this.pending.abort.abort(); this.pending.rejectCallback(failure('cancelled')); } }
  async disconnect() {
    this.cancelSignIn(); await this.signInTask?.catch(() => {});
    await this.locked(async () => { const record = await this.read(); if (record) await this.save({ clientId: record.clientId, subject: record.subject, identity: record.identity, scopes: [] }); });
    this.modelCache = null; this.verified = false; this.lastError = null;
  }
  async removeConnection() {
    this.cancelSignIn(); await this.signInTask?.catch(() => {});
    let remoteRevocation = 'not-needed';
    await this.locked(async () => {
      let record;
      try { record = await this.read(); } catch { remoteRevocation = 'unconfirmed'; }
      const token = record?.pendingRefresh?.credentials?.refreshToken || record?.credentials?.refreshToken;
      if (record?.credentials) remoteRevocation = 'unconfirmed';
      if (token) {
        try {
          const config = await this.discovery(), endpoint = new URL(config.revocation_endpoint);
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw failure('invalid_id_token');
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.remote(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: record.clientId }).toString(), signal: AbortSignal.timeout(5000) });
              if (response.status === 200) { remoteRevocation = 'confirmed'; break; }
              await response.body?.cancel().catch(() => {});
              if (response.status < 500) break;
            } catch {}
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
          }
        } catch {}
      }
      // Delete only this provider's immediate managed files, including obsolete login backups.
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (entry.isFile() && /^(?:host\.json|connection(?:\.unreadable\.[a-f0-9-]{36})?\.json|connection\.[a-f0-9-]{36}\.tmp)$/.test(entry.name)) await rm(path.join(this.directory, entry.name), { force: true });
      }
    });
    this.modelCache = null; this.verified = false; this.lastError = null;
    return { removed: true, remoteRevocation };
  }
  async accessToken() {
    if (this.pending) throw failure('connection_busy', 409);
    return this.locked(async () => {
      let record = await this.read();
      if (!record?.credentials) throw failure('sign_in_required', 401);
      if (!record.scopes.includes('chatgpt.tokens.use.direct') || !record.scopes.includes('resource.invoke')) throw failure('sharing_not_enabled', 403);
      if (!record.pendingRefresh && record.credentials.expiresAt <= Date.now() + 60000) {
        if (!record.credentials.refreshToken) throw failure('invalid_grant', 401);
        const config = await this.discovery();
        const data = await this.checkedJSON(await this.remote(config.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.credentials.refreshToken, resource: RESOURCE, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }).toString() }));
        const credentials = this.credentials(data);
        // Persist the rotated token before remote identity verification; preserve it on outages.
        record.pendingRefresh = { data, credentials }; await this.save(record);
      }
      if (record.pendingRefresh) {
        const { data, credentials } = record.pendingRefresh;
        const identity = await this.identity(data.id_token, record.clientId, undefined, record.subject);
        record = { clientId: record.clientId, ...identity, idToken: data.id_token, scopes: data.scope.split(/\s+/), credentials };
        await this.save(record);
      }
      if (!record.scopes.includes('chatgpt.tokens.use.direct') || !record.scopes.includes('resource.invoke')) throw failure('sharing_not_enabled', 403);
      if (record.credentials.expiresAt <= Date.now()) throw failure('invalid_grant', 401);
      return record.credentials.accessToken;
    });
  }
  async models(signal) {
    const accessToken = await this.accessToken();
    if (this.modelCache && this.modelCache.expires > Date.now()) return this.modelCache.models;
    const data = await this.checkedJSON(await this.remote(RESOURCE + '/models', { headers: { authorization: 'Bearer ' + accessToken }, signal }));
    const models = (Array.isArray(data.models) ? data.models : []).filter(model => model.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string').map(model => ({ slug: model.slug, displayName: model.display_name }));
    if (!models.length) throw failure('model_not_found', 403);
    this.modelCache = { models, expires: Date.now() + 30000 }; return models;
  }
  validate(input) {
    if (!Array.isArray(input?.messages) || input.messages.length < 1 || input.messages.length > 40 || input.messages.some(message => !['user', 'assistant'].includes(message?.role) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 12000) || input.messages.reduce((sum, item) => sum + item.text.length, 0) > 60000 || input.messages.at(-1).role !== 'user' || (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1600)) || (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 160))) throw Object.assign(new Error('消息格式或长度不符合要求。'), { code: 'invalid_request', status: 400 });
  }
  async respond(input, onDelta, signal) {
    this.validate(input);
    const models = await this.models(signal);
    const model = input.model || (input.voiceMode && models.find(item => item.slug === 'gpt-6-luna')?.slug) || models[0].slug;
    if (!models.some(item => item.slug === model)) throw failure('model_not_found');
    const voiceOptions = input.voiceMode ? { text: { verbosity: 'low' }, ...(model === 'gpt-6-luna' ? { reasoning: { effort: 'none' } } : model === 'gpt-6.1-sol' ? { reasoning: { effort: 'low' } } : {}) } : {};
    const accessToken = await this.accessToken();
    const response = await this.remote(RESOURCE + '/responses', { method: 'POST', headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json', accept: 'text/event-stream' }, signal, body: JSON.stringify({ model, input: input.messages.map(message => ({ role: message.role, content: message.text })), instructions: input.instructions || '你是中文数字人助手。用简洁、自然的中文回答。说明自己是 AI，不编造真实身份、经历或企业信息。', store: false, stream: true, ...voiceOptions }) });
    if (!response.ok) await this.checkedJSON(response);
    if (!response.body || (response.headers.get('content-type') && !response.headers.get('content-type').startsWith('text/event-stream'))) throw failure('stream_interrupted', 502);
    let buffer = '', text = '', completed = false;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const processEvent = record => {
      const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      let event; try { event = JSON.parse(data); } catch { throw failure('stream_interrupted', 502); }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') { text += event.delta; if (text.length > 256000) throw failure('response_incomplete', 502); onDelta(event.delta); }
      if (event.type === 'response.completed') completed = true;
      if (event.type === 'response.failed' || event.type === 'error') { const code = event.response?.error?.code || event.error?.code || event.code; throw failure(Object.hasOwn(errors, code) ? code : 'stream_interrupted', 502); }
      if (event.type === 'response.incomplete') throw failure('response_incomplete', 502);
    };
    try {
      while (!completed) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1000000) throw failure('stream_interrupted', 502);
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) { const record = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); processEvent(record); if (completed) break; }
      }
      if (!completed || !text.trim()) throw failure('stream_interrupted', 502);
      this.verified = true; this.lastError = null; return { text, model };
    } catch (error) { this.lastError = signal?.aborted ? failure('cancelled') : error; throw this.lastError; }
    finally { await reader.cancel().catch(() => {}); }
  }
}
