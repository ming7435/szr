import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWindowsEncryption } from './windows-encryption.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validFace = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validSecret = value => typeof value === 'string' && /^[\x21-\x7e]{10,4096}$/.test(value);

export class SimliService {
  constructor(root, options = {}) {
    this.directory = path.join(root, '.private/simli'); this.filename = path.join(this.directory, 'settings.json');
    this.encryption = options.encryption || createWindowsEncryption(); this.fetch = options.fetch || fetch;
    this.queue = Promise.resolve(); this.controllers = new Set();
  }
  async read() {
    try {
      const file = await readFile(this.filename, 'utf8');
      if (file === this.cachedFile) return this.cachedSettings;
      const envelope = JSON.parse(file);
      if (envelope.version !== 1 || envelope.provider !== this.encryption.id) throw new Error();
      const settings = JSON.parse(await this.encryption.decrypt(Buffer.from(envelope.ciphertext, 'base64')));
      if (!validSecret(settings.apiKey) || (settings.faceId && !validFace(settings.faceId)) || (settings.enabled && (!settings.faceId || settings.ownPortraitConfirmed !== true))) throw new Error();
      this.cachedFile = file; this.cachedSettings = settings; return settings;
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail('本机 Simli 配置无法读取，请重新保存。'); }
  }
  async saveSettings(input) {
    const job = this.queue.catch(() => {}).then(async () => {
      if (this.issuing) throw fail('视频连接正在建立，请稍后再修改设置。', 409);
      const previous = await this.read();
      const apiKey = input?.apiKey || previous?.apiKey;
      const faceId = input?.faceId === undefined ? previous?.faceId || null : input.faceId || null;
      const enabled = input?.enabled === true;
      const ownPortraitConfirmed = input?.ownPortraitConfirmed === true;
      if (!validSecret(apiKey) || (faceId && !validFace(faceId))) throw fail('请填写有效的 Simli API Key 和 Face ID。');
      if (enabled && (!faceId || !ownPortraitConfirmed)) throw fail('启用实时视频需要当前照片的人像模型 Face ID，并确认人像来源。');
      const settings = { apiKey, faceId, enabled, ownPortraitConfirmed };
      const ciphertext = await this.encryption.encrypt(JSON.stringify(settings));
      await mkdir(this.directory, { recursive: true });
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify({ version: 1, provider: this.encryption.id, ciphertext: Buffer.from(ciphertext).toString('base64') }), { flag: 'wx', mode: 0o600, flush: true }); await rename(temporary, this.filename); }
      finally { await rm(temporary, { force: true }); }
      this.cachedFile = null; return this.publicConfig();
    });
    this.queue = job.catch(() => {}); return job;
  }
  async publicConfig() {
    try {
      const settings = await this.read();
      return { enabled: settings?.enabled === true, credentialConfigured: !!settings, configured: !!(settings?.faceId && settings.ownPortraitConfirmed), faceId: settings?.faceId || null };
    } catch { return { enabled: false, credentialConfigured: false, configured: false, faceId: null, error: '本机 Simli 配置无法读取，请重新保存。' }; }
  }
  async request(endpoint, settings, options = {}, signal) {
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
      const response = await this.fetch('https://api.simli.ai' + endpoint, { ...options, headers: { 'x-simli-api-key': settings.apiKey, ...(options.body ? { 'content-type': 'application/json' } : {}) }, signal: combined, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw fail('Simli 密钥无效或没有服务权限，请检查本机配置。', response.status);
        if (response.status === 402) throw fail('Simli 试用额度不足，请先查看控制台余额。', 402);
        if (response.status === 429) throw fail('Simli 暂时达到并发或频率限制，请稍后再试。', 429);
        throw fail('Simli 未接受请求，请检查人像是否生成完成及试用额度。', 502);
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) { controller.abort(); throw fail('Simli 返回数据过长。', 502); } chunks.push(chunk); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Simli 返回格式异常，请稍后再试。', 502); }
    } catch (error) { if (error.status) throw error; throw fail(signal?.aborted ? '视频连接已取消。' : 'Simli 连接失败或超时，请检查网络。', 502); }
    finally { this.controllers.delete(controller); }
  }
  async listFaces(signal, settings = null) {
    settings ||= await this.read(); if (!settings) throw fail('请先保存 Simli 密钥。', 409);
    const data = await this.request('/faces', settings, {}, signal);
    if (!Array.isArray(data)) throw fail('Simli 人像列表格式异常。', 502);
    return data.filter(face => validFace(face?.id)).map(face => ({ id: face.id, version: Number.isInteger(face.simli_version) ? face.simli_version : null }));
  }
  async session(signal) {
    if (this.issuing) throw fail('正在建立视频连接，请稍后再试。', 409);
    this.issuing = true;
    try {
      const settings = await this.read();
      if (!settings?.enabled || !settings.faceId || !settings.ownPortraitConfirmed) throw fail('请先设置当前照片的实时人像模型 Face ID。', 409);
      const faces = await this.listFaces(signal, settings);
      if (!faces.some(face => face.id === settings.faceId)) throw fail('账号中未找到指定人像，请确认人像模型已生成完成。', 409);
      const iceServers = await this.request('/compose/ice', settings, {}, signal);
      if (!Array.isArray(iceServers) || !iceServers.length || iceServers.some(server => !(typeof server?.urls === 'string' || (Array.isArray(server?.urls) && server.urls.every(url => typeof url === 'string'))))) throw fail('Simli 未返回有效的网络连接配置。', 502);
      const result = await this.request('/compose/token', settings, { method: 'POST', body: JSON.stringify({ faceId: settings.faceId, apiVersion: 'v2', handleSilence: true, maxSessionLength: 900, maxIdleTime: 300, startFrame: 0, audioInputFormat: 'pcm16' }) }, signal);
      if (typeof result?.session_token !== 'string' || result.session_token.length < 8 || result.session_token.length > 16000 || result.session_token === settings.apiKey) throw fail('Simli 未返回有效的临时连接令牌。', 502);
      this.lastIssued = Date.now();
      return { sessionToken: result.session_token, iceServers, sampleRate: 16000, maxSessionLength: 900 };
    } finally { this.issuing = false; }
  }
  close() { for (const controller of this.controllers) controller.abort(); }
}
