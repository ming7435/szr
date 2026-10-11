import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BusinessStore } from './business-service.mjs';

export class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function environmentConfig() {
  return { apiKey: process.env.OPENAI_API_KEY?.trim() || '', baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini', customVoiceId: process.env.OPENAI_CUSTOM_VOICE_ID || '' };
}

export class RealtimeService {
  constructor(root, config = environmentConfig(), business = new BusinessStore(root)) { this.root = root; this.business = business; this.config = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-realtime-2.1-mini', ...config }; this.creatingVoice = false; }
  async customVoiceId() {
    try { const saved = JSON.parse(await readFile(path.join(this.root, '.private', 'voice.json'), 'utf8')); if (saved.id) return saved.id; } catch {}
    return this.config.customVoiceId || '';
  }
  async publicConfig() { return { apiConfigured: !!this.config.apiKey, model: this.config.model, customVoiceId: (await this.customVoiceId()) || null, image: '/assets/avatar.png', referenceAudio: '/assets/voice-reference-clean.m4a' }; }
  requireKey() { if (!this.config.apiKey) throw new ServiceError(503, '本机尚未配置 OpenAI API Key，请完成密钥配置后再连接。'); }
  async request(endpoint, body, customVoice = false) {
    this.requireKey();
    let response;
    try {
      response = await fetch(`${this.config.baseUrl}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}` }, body, signal: AbortSignal.timeout(customVoice ? 90000 : 35000) });
    } catch { throw new ServiceError(502, '无法连接 OpenAI，请检查网络后重试。'); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})); const code = data.error?.code;
      if (response.status === 401) throw new ServiceError(401, 'OpenAI API Key 无效或已失效，请检查本机配置。');
      if (response.status === 429) throw new ServiceError(429, code === 'insufficient_quota' ? 'OpenAI API 额度不足，请在平台检查余额。' : '请求过于频繁，请稍后重试。');
      if (customVoice && [403, 404].includes(response.status)) throw new ServiceError(response.status, '当前 OpenAI 项目可能未开通自定义音色权限，请检查账号权限和授权录音。');
      if ([403, 404].includes(response.status)) throw new ServiceError(response.status, '当前项目无法使用该模型或专属音色，请检查账号权限与配置。');
      if (customVoice && response.status === 400) throw new ServiceError(400, '音色创建被拒绝，请检查授权语句是否完整准确、两份录音是否同一说话人，以及音频格式。');
      throw new ServiceError(502, 'OpenAI 未能建立语音会话，请检查模型、音色和项目设置后重试。');
    }
    return response;
  }
  async session(input) {
    this.requireKey();
    if (!input || typeof input.sdp !== 'string' || !input.sdp.startsWith('v=0') || input.sdp.length > 100000) throw new ServiceError(400, '无效的 WebRTC 会话请求。');
    if (input.voice !== undefined && input.voice !== 'custom') throw new ServiceError(400, '数字人固定使用你上传声音的专属音色，无法切换其他声音。');
    const id = await this.customVoiceId();
    if (!id) throw new ServiceError(409, '数字人的专属音色尚未接入，请先完成音色创建。');
    const voice = { id };
    const eagerness = input.eagerness || 'auto';
    if (!['auto', 'low', 'medium', 'high'].includes(eagerness)) throw new ServiceError(400, '无效的回应节奏。');
    if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1600)) throw new ServiceError(400, '数字人设置最多支持 1600 字。');
    const mode = input.mode || 'chat';
    if (!['chat', 'reception'].includes(mode)) throw new ServiceError(400, '请选择日常交流或企业接待。');
    const session = { type: 'realtime', model: this.config.model, output_modalities: ['audio'], max_output_tokens: 800, instructions: input.instructions?.trim() || '你是一位友好自然的中文 AI 数字分身。用简洁的普通话回答，不编造真实身份和个人经历。', audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'zh' }, noise_reduction: { type: 'near_field' }, turn_detection: { type: 'semantic_vad', eagerness, create_response: true, interrupt_response: true } }, output: { voice } } };
    if (mode === 'reception') Object.assign(session, await this.business.receptionContext(input.instructions?.trim()));
    const form = new FormData(); form.set('sdp', input.sdp); form.set('session', JSON.stringify(session));
    const response = await this.request('/realtime/calls', form);
    const sdp = await response.text();
    if (!sdp.startsWith('v=0')) throw new ServiceError(502, '语音服务返回了无效的会话数据。');
    return { sdp };
  }
  async createVoice(input) {
    this.requireKey();
    if (this.creatingVoice) throw new ServiceError(429, '正在创建音色，请等待完成。');
    if (!input || typeof input.consentAudio !== 'string' || input.consentAudio.length > 14000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.consentAudio)) throw new ServiceError(400, '请提供有效的授权录音。');
    const mimeTypes = { 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
    if (!mimeTypes[input.mimeType]) throw new ServiceError(400, '请使用 WAV、M4A、MP3 或 WebM 格式的授权录音。');
    const recording = Buffer.from(input.consentAudio, 'base64');
    if (recording.length < 1000 || recording.length > 10 * 1024 * 1024) throw new ServiceError(400, '授权录音为空、过短或超过 10 MB。');
    this.creatingVoice = true;
    try {
      const sample = await readFile(path.join(this.root, 'public', 'assets', 'voice-reference-clean.wav'));
      const privateDir = path.join(this.root, '.private'); await mkdir(privateDir, { recursive: true });
      const digest = createHash('sha256').update(recording).update(this.config.apiKey).digest('hex');
      let consent;
      try { const previous = JSON.parse(await readFile(path.join(privateDir, 'consent.json'), 'utf8')); if (previous.digest === digest) consent = previous.id; } catch {}
      if (!consent) {
        const form = new FormData(); form.set('name', 'Digital human voice consent'); form.set('language', 'zh'); form.set('recording', new Blob([recording], { type: input.mimeType }), `consent.${mimeTypes[input.mimeType]}`);
        const response = await this.request('/audio/voice_consents', form, true); const result = await response.json();
        if (typeof result.id !== 'string' || !result.id) throw new ServiceError(502, '授权录音上传结果无效，请重试。');
        consent = result.id; await writeFile(path.join(privateDir, 'consent.json'), JSON.stringify({ id: consent, digest }), 'utf8');
      }
      const form = new FormData(); form.set('name', 'My digital human voice'); form.set('consent', consent); form.set('audio_sample', new Blob([sample], { type: 'audio/wav' }), 'voice-reference-clean.wav');
      const response = await this.request('/audio/voices', form, true); const voice = await response.json();
      if (typeof voice.id !== 'string' || !voice.id) throw new ServiceError(502, '音色创建结果无效，请重试。');
      await writeFile(path.join(privateDir, 'voice.json'), JSON.stringify({ id: voice.id, consent, createdAt: new Date().toISOString() }, null, 2), 'utf8');
      return { id: voice.id };
    } finally { this.creatingVoice = false; }
  }
}
