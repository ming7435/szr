import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createWindowsEncryption } from './windows-encryption.mjs';
import { encodeFrame, decodeFrame } from './doubao-protocol.mjs';
import { GuideStore } from './guide-service.mjs';
import { guidePreferences } from './public/guide-persona.js';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const UPSTREAM = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const AVATAR_IDENTITY = '你是一位景区讲解员，是用户创建的 AI 数字人，统一提供景区旅游讲解，没有固定个人姓名。讲解内容由当前景区资料决定，自我介绍时说明当前景区和讲解职责。豆包是底层语音服务的名称，不是你的名字；不要自称豆包，也不要主动朗读或介绍底层服务商名称。';
const SPEECH_DELIVERY = '发声要求（优先于交流偏好中的语气描述）：保留当前复刻音色，以自然、清晰、利落的普通话讲解；语气平实、亲切而克制，按正常交谈节奏说短句。吐字清楚，词句边界分明，停顿简短，句尾干脆自然收住，不故意拖长元音。不要撒娇、卖萌、耳语、刻意气声或黏腻的亲昵语气，不用“嗯～”“呀～”“哦～”等拖尾语气词；不模仿其他人的声音。';
export class DoubaoService {
  constructor(root, options = {}) {
    this.directory = path.join(root, '.private/doubao'); this.filename = path.join(this.directory, 'settings.json');
    this.encryption = options.encryption || createWindowsEncryption(); this.upstreamURL = options.upstreamURL || UPSTREAM;
    this.guide = options.guide || new GuideStore(root);
    this.sessions = new Set(); this.queue = Promise.resolve();
  }
  async read() {
    try {
      const file = await readFile(this.filename, 'utf8'); if (file === this.cachedFile) return this.cachedSettings;
      const envelope = JSON.parse(file); if (envelope.provider !== this.encryption.id || envelope.version !== 1) throw new Error();
      const settings = JSON.parse(await this.encryption.decrypt(Buffer.from(envelope.ciphertext, 'base64')));
      this.validate(settings); this.cachedFile = file; this.cachedSettings = settings; return settings;
    } catch (error) { if (error.code === 'ENOENT') return null; throw failure('豆包配置无法读取，请在本机设置中重新保存。'); }
  }
  validate(input) {
    const validSecret = value => typeof value === 'string' && /^[\x21-\x7e]{10,4096}$/.test(value);
    const validAuth = input?.authMode === 'api-key' ? validSecret(input.apiKey) : (!input?.authMode || input.authMode === 'app-token') && /^\d{5,30}$/.test(input?.appId || '') && validSecret(input?.accessToken);
    if (!validAuth || !/^S_[a-zA-Z0-9_-]{4,120}$/.test(input?.voiceId || '') || input?.ownVoiceConfirmed !== true) throw failure('请填写有效的应用凭据和由你上传录音复刻的 S_ 音色 ID，并确认音色来源。');
  }
  async saveSettings(input) {
    this.validate(input);
    const settings = { ...(input.authMode === 'api-key' ? { authMode: 'api-key', apiKey: input.apiKey } : { authMode: 'app-token', appId: input.appId, accessToken: input.accessToken }), voiceId: input.voiceId, ownVoiceConfirmed: true };
    const job = this.queue.catch(() => {}).then(async () => {
      if (this.sessions.size) throw failure('请先结束对话，再修改豆包配置。', 409);
      await mkdir(this.directory, { recursive: true });
      const ciphertext = await this.encryption.encrypt(JSON.stringify(settings)), temporary = this.filename + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify({ version: 1, provider: this.encryption.id, ciphertext: Buffer.from(ciphertext).toString('base64') }), { flag: 'wx', mode: 0o600, flush: true }); await rename(temporary, this.filename); }
      finally { await rm(temporary, { force: true }); }
      await writeFile(path.join(this.directory, 'selected.json'), '{"selected":true}', { flush: true }); this.cachedFile = null;
      return this.publicConfig();
    });
    this.queue = job.catch(() => {}); return job;
  }
  async publicConfig() {
    let selected = false; try { selected = JSON.parse(await readFile(path.join(this.directory, 'selected.json'), 'utf8')).selected === true; } catch {}
    try { const settings = await this.read(); return { selected, configured: !!settings, voice: 'uploaded-reference', ...(settings ? { authMode: settings.authMode || 'app-token', ...(settings.appId ? { appId: settings.appId } : {}), voiceId: settings.voiceId } : {}) }; }
    catch { return { selected, configured: false, voice: 'uploaded-reference', error: '本机豆包配置无法读取，请重新保存。' }; }
  }
  attach(server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 131072 });
    server.on('upgrade', (request, socket, head) => {
      if (request.url === '/api/avatar/live') return;
      const host = request.headers.host || '';
      let hostname; try { hostname = new URL('http://' + host).hostname; } catch {}
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || request.headers.origin !== 'http://' + host || request.url !== '/api/doubao/live') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      this.wss.handleUpgrade(request, socket, head, client => this.connect(client));
    });
  }
  connect(client) {
    if (this.sessions.size) { client.close(1013, '已有语音对话，请先结束。'); return; }
    const state = { client, sessionId: randomUUID(), ready: false, closing: false, muted: false, suppressed: false, waitingQuestion: false, cancelled: new Set(), replyId: null, questionId: null, cancelledQuestions: new Set() };
    this.sessions.add(state);
    const send = event => { if (client.readyState === WebSocket.OPEN && !state.closing) client.send(JSON.stringify(event)); };
    const close = () => {
      if (state.closing) return;
      state.closing = true; clearTimeout(state.timeout); clearTimeout(state.maximum);
      this.sessions.delete(state);
      const upstream = state.upstream;
      if (upstream?.readyState === WebSocket.OPEN) { if (state.ready) upstream.send(encodeFrame(102, {}, state.sessionId)); else upstream.send(encodeFrame(2, {})); state.finishTimer = setTimeout(() => upstream.terminate(), 1000); state.finishTimer.unref(); }
      else upstream?.terminate();
      client.close();
    };
    state.close = close;
    const fail = message => { send({ type: 'error', error: message }); close(); };
    const upstreamSend = (event, payload) => { if (state.upstream?.readyState === WebSocket.OPEN) state.upstream.send(encodeFrame(event, payload, event >= 100 ? state.sessionId : '')); };
    const cancelReply = () => {
      if (state.replyId) { state.cancelled.add(state.replyId); if (state.cancelled.size > 40) state.cancelled.delete(state.cancelled.values().next().value); }
      if (state.questionId) { state.cancelledQuestions.add(state.questionId); if (state.cancelledQuestions.size > 40) state.cancelledQuestions.delete(state.cancelledQuestions.values().next().value); }
      state.suppressed = true; state.waitingQuestion = true;
    };
    state.timeout = setTimeout(() => fail('豆包连接超时，请检查服务开通和本机网络。'), 25000); state.timeout.unref();
    state.maximum = setTimeout(() => fail('本次对话已达 15 分钟，请重新开始。'), 15 * 60 * 1000); state.maximum.unref();
    client.on('close', close); client.on('error', close);
    client.on('message', async (bytes, binary) => {
      try {
        if (state.closing) return;
        if (binary) {
          if (!state.ready || bytes.length > 32768 || bytes.length % 2 || bytes.length < 2) throw failure('实时录音格式不正确。');
          if (state.upstream.bufferedAmount > 1048576) throw failure('网络发送积压，请重新连接。');
          upstreamSend(200, state.muted ? Buffer.alloc(bytes.length) : Buffer.from(bytes)); return;
        }
        if (bytes.length > 8000) throw failure('实时设置过长。');
        const event = JSON.parse(bytes.toString());
        if (event.type === 'stop') { close(); return; }
        if (event.type === 'mute') { state.muted = event.muted === true; return; }
        if (event.type === 'interrupt') {
          const replyId = typeof event.replyId === 'string' && event.replyId.length <= 256 ? event.replyId : null;
          const questionId = typeof event.questionId === 'string' && event.questionId.length <= 256 ? event.questionId : null;
          if (!replyId && !questionId) return;
          const currentQuestion = questionId ? (!state.questionId || questionId === state.questionId) : replyId === state.replyId;
          if (currentQuestion) cancelReply();
          else {
            if (replyId) state.cancelled.add(replyId);
            if (questionId) state.cancelledQuestions.add(questionId);
            if (state.cancelled.size > 40) state.cancelled.delete(state.cancelled.values().next().value);
            if (state.cancelledQuestions.size > 40) state.cancelledQuestions.delete(state.cancelledQuestions.values().next().value);
          }
          if (state.ready && replyId && Number.isFinite(event.audioEndMs) && event.audioEndMs >= 0 && event.audioEndMs <= 900000) upstreamSend(513, { item_id: replyId, audio_end_ms: Math.round(event.audioEndMs) });
          return;
        }
        if (event.type !== 'start' || state.starting || state.upstream) throw failure('实时会话事件无效。');
        if (event.instructions !== undefined && (typeof event.instructions !== 'string' || event.instructions.length > 1600)) throw failure('数字人设置最多支持 1600 字。');
        state.starting = true;
        const settings = await this.read(); if (state.closing) return;
        if (!settings) throw failure('请先在设置中配置豆包实时语音和你的复刻音色。');
        const instructions=event.guideScene === undefined ? guidePreferences(event.instructions || '') || '用简洁自然的普通话回答，不编造身份和经历。' : await this.guide.instructions(event.guideScene,event.instructions?.trim());
        if(state.closing)return;
        const upstream = new WebSocket(this.upstreamURL, { handshakeTimeout: 20000, maxPayload: 2 * 1024 * 1024, headers: {
          ...(settings.authMode === 'api-key' ? { 'X-Api-Key': settings.apiKey } : { 'X-Api-App-ID': settings.appId, 'X-Api-Access-Key': settings.accessToken }),
          'X-Api-Resource-Id': 'volc.speech.dialog', 'X-Api-App-Key': 'PlgvMymc7f3tQnJ6', 'X-Api-Connect-Id': randomUUID(),
        } });
        state.upstream = upstream;
        upstream.on('open', () => { if (!state.closing) upstreamSend(1, {}); });
        upstream.on('error', () => { if (!state.closing) fail('豆包连接失败，请检查 APP ID、Access Token、实时语音权限及网络。'); });
        upstream.on('close', () => { clearTimeout(state.finishTimer); if (!state.closing) fail('豆包语音连接已关闭，请重新连接。'); });
        upstream.on('message', bytes => {
          try {
            const message = decodeFrame(bytes);
            if (state.closing) { if (message.event === 152) { upstreamSend(2, {}); upstream.close(); } return; }
            if (message.type === 15 || [51, 153].includes(message.event)) throw failure('豆包拒绝了本次会话，请检查服务权限、额度和复刻 2.0 音色配置。');
            if (message.event >= 100 && message.sessionId !== state.sessionId) throw failure('实时会话标识不匹配。');
            if (message.event === 50) upstreamSend(100, {
              asr: { extra: { enable_custom_vad: true, end_smooth_window_ms: 500 } },
              tts: { speaker: settings.voiceId, extra: {}, audio_config: { format: 'pcm_s16le', sample_rate: 24000, channel: 1 } },
              dialog: { character_manifest: AVATAR_IDENTITY + '\n' + instructions + '\n' + SPEECH_DELIVERY, extra: { model: '2.2.0.0', input_mod: 'keep_alive', enable_conversation_truncate: true } },
            });
            if (message.event === 150) { state.ready = true; clearTimeout(state.timeout); send({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 }); }
            if (message.event === 450) { cancelReply(); state.waitingQuestion = false; state.replyId = null; state.questionId = typeof message.payload.question_id === 'string' ? message.payload.question_id : null; send({ type: 'speech_started', questionId: state.questionId }); }
            if (message.event === 459) send({ type: 'speech_stopped' });
            if (message.event === 350) {
              const replyId = message.payload.reply_id;
              const questionId = message.payload.question_id;
              if (typeof replyId !== 'string' || !replyId || state.cancelled.has(replyId) || state.waitingQuestion || state.cancelledQuestions.has(questionId) || (state.questionId && questionId !== state.questionId)) { state.suppressed = true; return; }
              if (replyId !== state.replyId) { state.replyId = replyId; send({ type: 'response_started', replyId, questionId }); }
              state.suppressed = false;
            }
            if (message.event === 352 && !state.suppressed && state.replyId) {
              if (!Buffer.isBuffer(message.payload) || message.payload.length % 2 || client.bufferedAmount > 1048576) throw failure('实时音频格式或网络缓冲异常，请重新连接。');
              if (client.readyState === WebSocket.OPEN) client.send(message.payload);
            }
            if (message.event === 359 && !state.suppressed && message.payload.reply_id === state.replyId) send({ type: 'response_ended', replyId: state.replyId });
          } catch (error) { fail(error.status ? error.message : '豆包实时协议响应异常，请重新连接。'); }
        });
      } catch (error) { if (!state.closing) fail(error.status ? error.message : '实时请求未完成，请检查本机配置。'); }
    });
  }
  close() { for (const state of [...this.sessions]) state.close(); this.wss?.close(); }
}
