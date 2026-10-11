import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export function validateVoiceTurn(input) {
  if (typeof input?.audioBase64 !== 'string' || input.audioBase64.length > 1300000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64)) throw fail('语音格式不正确。', 400);
  const wav = Buffer.from(input.audioBase64, 'base64');
  if (wav.length < 3244 || wav.length > 960044 || wav.subarray(0, 4).toString() !== 'RIFF' || wav.subarray(8, 12).toString() !== 'WAVE' || wav.subarray(12, 16).toString() !== 'fmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.subarray(36, 40).toString() !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 || wav.readUInt32LE(4) !== wav.length - 8) throw fail('请发送 16 kHz 单声道录音，最长 30 秒。', 400);
  const history = input.history || [];
  if (!Array.isArray(history) || history.length > 20 || history.some(item => !['user', 'assistant'].includes(item?.role) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 12000) || history.reduce((sum, item) => sum + item.text.length, 0) > 48000 || (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 1600))) throw fail('对话记录格式不正确。', 400);
}

export class LocalVoiceService {
  constructor(root) {
    this.root = root; this.python = path.join(root, '.runtime/voice-env/Scripts/python.exe');
    this.pending = new Map(); this.activeId = null; this.status = 'idle';
  }
  async publicStatus() {
    const paths = [this.python, path.join(this.root, '.runtime/whisper-small/model.bin'), path.join(this.root, '.runtime/openvoice-models/checkpoints/converter/checkpoint.pth'), path.join(this.root, '.runtime/openvoice-models/checkpoints/base_speakers/ZH/checkpoint.pth')];
    const installed = (await Promise.all(paths.map(filename => access(filename).then(() => true, () => false)))).every(Boolean);
    return { available: installed, status: this.status, voice: 'uploaded-reference' };
  }
  async prepare() {
    if (this.status === 'ready') return;
    if (this.starting) return this.starting;
    this.starting = this.startWorker().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startWorker() {
    if (!(await this.publicStatus()).available) throw fail('本机声音模型尚未准备完成。', 503);
    this.status = 'loading';
    const child = spawn(this.python, ['-u', path.join(this.root, 'scripts/local-voice-worker.py')], { cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '4' } });
    this.worker = child;
    return new Promise((resolve, reject) => {
      let buffer = '', settled = false;
      const timer = setTimeout(() => { child.kill(); failed('本机声音模型启动超时，请重试。'); }, 90000);
      const failed = message => {
        if (this.worker !== child) return;
        this.worker = null; this.activeId = null; clearTimeout(this.activeTimer); this.activeTimer = null; this.status = 'error'; child.kill();
        for (const job of this.pending.values()) job.reject(fail(message));
        this.pending.clear();
        if (!settled) { settled = true; clearTimeout(timer); reject(fail(message)); }
      };
      child.stdout.on('data', chunk => {
        if (this.worker !== child) return;
        buffer += chunk.toString('utf8');
        if (buffer.length > 16000000) { child.kill(); return failed('本机声音响应过长。'); }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { child.kill(); return failed('本机声音服务返回异常。'); }
          if (event.type === 'ready') { this.status = 'ready'; if (!settled) { settled = true; clearTimeout(timer); resolve(); } }
          else if (event.type === 'fatal') { child.kill(); failed('本机声音模型无法加载，请检查本机运行环境。'); }
          else this.finishOperation(event);
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', () => failed('本机声音服务无法启动。'));
      child.on('close', () => failed('本机声音服务已停止，请重新连接。'));
      child.stdin.on('error', () => failed('本机声音服务连接已中断。'));
    });
  }
  dispatchNext() {
    if (this.status !== 'ready' || this.activeId || !this.worker) return;
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [id, job] = next; this.activeId = id;
    const worker = this.worker;
    // The CPU deadline outlives cancellation of its browser waiter.
    this.activeTimer = setTimeout(() => { if (this.worker === worker && this.activeId === id) worker.kill(); }, 90000);
    worker.stdin.write(job.line, error => { if (error) { job.reject(fail('声音服务连接中断。')); worker.kill(); } });
  }
  finishOperation(event) {
    if (event.id !== this.activeId) return;
    this.activeId = null; clearTimeout(this.activeTimer); this.activeTimer = null;
    const job = this.pending.get(event.id);
    if (job) event.error ? job.reject(fail('本机语音处理未完成，请重试。')) : job.resolve(event.result);
    this.dispatchNext();
  }
  async call(operation, input, signal) {
    signal?.throwIfAborted(); await this.prepare(); signal?.throwIfAborted();
    const activeDiscarded = this.activeId && !this.pending.has(this.activeId) ? 1 : 0;
    if (this.pending.size + activeDiscarded >= 3) throw fail('语音正在处理中，请稍后再说。', 429);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); error ? reject(error) : resolve(value); this.dispatchNext(); };
      const abort = () => finish(fail('已打断本次回答。', 499));
      timer = setTimeout(() => { finish(fail('语音处理超时，请重试。')); if (this.activeId === id) this.worker?.kill(); }, 90000);
      this.pending.set(id, { line: JSON.stringify({ id, operation, ...input }) + '\n', resolve: value => finish(null, value), reject: error => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      this.dispatchNext();
    });
  }
  async welcome(signal) {
    await this.prepare(); signal?.throwIfAborted();
    this.welcomeAudio ??= this.call('synthesize', { text: '你好，我是你的数字分身。你想聊些什么？' }).catch(error => { this.welcomeAudio = null; throw error; });
    const audio = await this.welcomeAudio; signal?.throwIfAborted(); return audio;
  }
  async turn(input, chatgpt, signal) {
    validateVoiceTurn(input);
    const recognized = await this.call('recognize', { audioBase64: input.audioBase64 }, signal);
    if (!recognized.text?.trim()) return { heard: false };
    if (recognized.text.length > 12000) throw fail('这段话太长，请分几次说。', 400);
    const history = input.history || [];
    const instructions = (input.instructions || '你是友好、自然的中文数字人助手。').slice(0, 1350) + '\n这是语音对话。使用普通话，用一到两句话直接回答，通常不超过八十个汉字。不使用 Markdown、列表或表情符号。';
    const answer = await chatgpt.respond({ messages: [...history, { role: 'user', text: recognized.text }], instructions }, () => {}, signal);
    signal?.throwIfAborted();
    const speakable = answer.text.replace(/```[\s\S]*?```/g, '').replace(/[*#`_]/g, '').trim();
    if (!speakable || speakable.length > 1200) throw fail('这次回答不适合朗读，请换一种问法。', 400);
    const audio = await this.call('synthesize', { text: speakable }, signal);
    return { heard: true, userText: recognized.text, replyText: answer.text, ...audio };
  }
  async streamTurn(input, chatgpt, onEvent, signal) {
    validateVoiceTurn(input);
    const started = performance.now(), controller = new AbortController();
    const currentSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let firstAudio, firstText = '', buffer = '';
    const speakable = text => text.replace(/```[\s\S]*?```/g, '').replace(/[*#`_]/g, '').trim();
    try {
      const recognized = await this.call('recognize', { audioBase64: input.audioBase64 }, currentSignal);
      currentSignal.throwIfAborted();
      if (!recognized.text?.trim()) { onEvent({ type: 'done', heard: false }); return; }
      if (recognized.text.length > 12000) throw fail('这段话太长，请分几次说。', 400);
      const afterRecognition = performance.now();
      onEvent({ type: 'recognized', userText: recognized.text });
      const instructions = (input.instructions || '你是友好、自然的中文数字人助手。').slice(0, 1250) + '\n这是语音对话。使用普通话，用一到两句简短的话直接回答，通常不超过五十个汉字。先用十六个汉字以内的短句回应核心问题，再按需补充。第一句要有实际内容，不说等待或占位的话。不使用 Markdown、列表或表情符号。';
      const answer = await chatgpt.respond({ voiceMode: true, messages: [...(input.history || []), { role: 'user', text: recognized.text }], instructions }, delta => {
        buffer += delta;
        // Overlap only the first conversion with model generation. Audio is
        // published after the model completes, so failed answers stay unheard.
        if (firstAudio || buffer.includes('```') || buffer.length > 1200) return;
        const clean = speakable(buffer);
        for (const boundary of clean.matchAll(/[。！？!?；;，,：:]/g)) {
          const end = boundary.index + 1;
          if (end < 8) continue;
          if (end > 32) break;
          firstText = clean.slice(0, end);
          firstAudio = this.call('synthesize', { text: firstText }, currentSignal);
          firstAudio.catch(() => {}); break;
        }
      }, currentSignal);
      currentSignal.throwIfAborted();
      const afterModel = performance.now(), text = speakable(answer.text);
      if (!text || text.length > 1200) throw fail('这次回答不适合朗读，请换一种问法。', 400);
      let rest = text, firstAt;
      if (firstAudio && text.startsWith(firstText)) {
        const audio = await firstAudio; currentSignal.throwIfAborted();
        firstAt = performance.now(); onEvent({ type: 'audio', index: 0, ...audio });
        rest = text.slice(firstText.length).trim();
      } else if (firstAudio) { await firstAudio; currentSignal.throwIfAborted(); }
      if (rest) {
        const audio = await this.call('synthesize', { text: rest }, currentSignal); currentSignal.throwIfAborted();
        const index = firstAt === undefined ? 0 : 1; firstAt ??= performance.now();
        onEvent({ type: 'audio', index, ...audio });
      }
      onEvent({ type: 'done', heard: true, userText: recognized.text, replyText: answer.text, model: answer.model, timings: {
        recognitionSeconds: (afterRecognition - started) / 1000, modelSeconds: (afterModel - afterRecognition) / 1000,
        firstAudioSeconds: (firstAt - started) / 1000, totalSeconds: (performance.now() - started) / 1000,
      } });
    } catch (error) { controller.abort(); await firstAudio?.catch(() => {}); throw error; }
  }
  close() { this.worker?.kill(); }
}
