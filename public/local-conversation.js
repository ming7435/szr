export function pcmWave(frames, sourceRate) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const source = new Float32Array(length); let offset = 0;
  for (const frame of frames) { source.set(frame, offset); offset += frame.length; }
  const count = Math.min(480000, Math.floor(length * 16000 / sourceRate));
  const wave = new ArrayBuffer(44 + count * 2), data = new DataView(wave);
  const word = (at, text) => { for (let i = 0; i < text.length; i++) data.setUint8(at + i, text.charCodeAt(i)); };
  word(0, 'RIFF'); data.setUint32(4, wave.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, 16000, true); data.setUint32(28, 32000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  word(36, 'data'); data.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const position = i * sourceRate / 16000, left = Math.floor(position), mix = position - left;
    const sample = source[left] * (1 - mix) + (source[left + 1] ?? source[left]) * mix;
    data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true);
  }
  let encoded = ''; const bytes = new Uint8Array(wave);
  for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(encoded);
}

export class LocalConversation {
  constructor({ audio, onStatus, onMessage, onError, onConnection, onAudio }) {
    Object.assign(this, { audio, onStatus, onMessage, onError, onConnection, onAudio });
    this.generation = 0; this.history = []; this.turnGeneration = 0; this.audioQueue = [];
    audio.addEventListener('ended', () => { if (this.connected) { this.playing = false; this.drainAudio(); } });
  }
  async request(url, data, signal) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '语音服务暂时无法连接。'); return result;
  }
  async connect(settings) {
    this.disconnect(false); const generation = this.generation;
    const current = () => generation === this.generation;
    this.settings = settings; this.history = []; this.muted = false; this.chunks = []; this.preRoll = []; this.voiceBlocks = 0; this.energyWindow = []; this.captureThreshold = null;
    this.controller = new AbortController();
    this.onStatus('正在准备对话', '请允许使用麦克风。');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请用 Chrome 或 Edge 打开本机网页。');
      const context = new AudioContext({ sampleRate: 16000 }); this.context = context; await context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); throw new Error('连接已取消。'); }
      this.microphone = stream;
      const welcome = await this.request('/api/local-voice/start', {}, this.controller.signal);
      if (!current()) throw new Error('连接已取消。');
      await context.audioWorklet.addModule('/microphone-worklet.js');
      if (!current()) throw new Error('连接已取消。');
      this.source = context.createMediaStreamSource(stream);
      this.worklet = new AudioWorkletNode(context, 'microphone-frames');
      const silent = context.createGain(); silent.gain.value = 0; this.silent = silent;
      this.source.connect(this.worklet); this.worklet.connect(silent); silent.connect(context.destination);
      this.worklet.port.onmessage = event => { if (current() && this.connected) this.capture(event.data); };
      this.connected = true; this.onConnection(true); await this.play(welcome, generation);
    } catch (error) {
      if (current()) this.disconnect();
      if (error.name === 'NotAllowedError') throw new Error('请允许浏览器使用麦克风，再点击开始对话。');
      if (error.name === 'AbortError') throw new Error('连接已取消。');
      throw error;
    }
  }
  async play(result, generation) {
    const turn = this.turnGeneration;
    if (generation !== this.generation || !this.connected || turn !== this.turnGeneration) return;
    if (result.voice !== 'uploaded-reference' || result.mimeType !== 'audio/wav' || !result.audioBase64) throw new Error('未收到你的音色生成的声音。');
    const binary = atob(result.audioBase64), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    this.audio.pause(); if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audio.srcObject = null; this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); this.audio.src = this.audioUrl;
    this.playing = true; this.playStarted = performance.now(); await this.onAudio();
    if (generation !== this.generation || !this.connected || turn !== this.turnGeneration) return;
    this.onStatus('我正在回应');
    try { await this.audio.play(); }
    catch { this.onError('请点击「开启声音」播放回答。'); document.getElementById('audio-resume')?.removeAttribute('hidden'); }
  }
  capture(frame) {
    if (this.muted) return;
    const milliseconds = frame.length / this.context.sampleRate * 1000;
    const rms = Math.sqrt(frame.reduce((total, value) => total + value * value, 0) / frame.length);
    // Calibrate while idle, then keep speech out of the background estimate.
    if (!this.recording) { this.energyWindow.push(rms); if (this.energyWindow.length > 64) this.energyWindow.shift(); }
    const sortedEnergy = [...this.energyWindow].sort((a, b) => a - b);
    const floor = sortedEnergy[Math.floor(sortedEnergy.length * .2)] || 0;
    const listeningThreshold = Math.max(.012, Math.min(.06, floor * 2.5));
    const threshold = this.recording ? this.captureThreshold : Math.max(this.playing ? .026 : .012, listeningThreshold);
    const voiced = rms > threshold;
    this.preRoll.push(frame); if (this.preRoll.length > 4) this.preRoll.shift();
    if (!this.recording) {
      this.voiceBlocks = voiced ? this.voiceBlocks + 1 : 0;
      if (this.voiceBlocks < 2 || (this.playing && performance.now() - this.playStarted < 300)) return;
      this.interrupt(false); this.recording = true; this.captureThreshold = listeningThreshold; this.chunks = [...this.preRoll]; this.duration = this.chunks.length * milliseconds; this.voicedTime = this.voiceBlocks * milliseconds; this.silence = 0;
      this.onStatus('正在听你说'); return;
    }
    this.chunks.push(frame); this.duration += milliseconds;
    if (voiced) { this.silence = 0; this.voicedTime += milliseconds; } else this.silence += milliseconds;
    const wait = this.settings.eagerness === 'low' ? 1300 : this.settings.eagerness === 'high' ? 550 : 850;
    if (this.duration >= 29500 || this.silence >= wait) {
      const frames = this.chunks; this.chunks = []; this.preRoll = []; this.recording = false; this.captureThreshold = null; this.voiceBlocks = 0;
      if (this.voicedTime >= 250) this.answer(frames);
    }
  }
  async answer(frames) {
    this.turnController?.abort(); const controller = new AbortController(); this.turnController = controller;
    const generation = this.generation, turn = ++this.turnGeneration;
    this.receiving = true; this.onStatus('正在思考你的问题');
    const current = () => generation === this.generation && turn === this.turnGeneration;
    let reader;
    try {
      const response = await fetch('/api/local-voice/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioBase64: pcmWave(frames, this.context.sampleRate), history: this.history, instructions: this.settings.instructions }), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || '语音服务暂时无法连接。'); }
      if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('语音连接中断，请重试。');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', done = false, index = 0;
      while (current()) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }); if (buffer.length > 16000000) throw new Error('语音响应过长。');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0 && current()) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const event = JSON.parse(line); if (done) throw new Error('语音响应顺序异常。');
          if (event.type === 'error') throw new Error(event.error || '这次回答未完成，请重试。');
          if (event.type === 'recognized') { this.history.push({ role: 'user', text: event.userText }); this.trimHistory(); this.onMessage('user', event.userText); }
          if (event.type === 'audio') {
            if (event.index !== index++ || event.voice !== 'uploaded-reference') throw new Error('未收到你的音色生成的声音。');
            this.audioQueue.push(event); this.drainAudio();
          }
          if (event.type === 'done') {
            done = true; this.receiving = false;
            if (event.heard) { this.history.push({ role: 'assistant', text: event.replyText }); this.onMessage('assistant', event.replyText); }
            this.trimHistory();
            if (!this.playing) this.drainAudio();
          }
        }
      }
      if (current() && !done) throw new Error('语音连接中断，回答未完成。');
    } catch (error) {
      if (current() && error.name !== 'AbortError') { this.interrupt(false); this.onError(error.message); this.onStatus('正在听你说'); }
    } finally { await reader?.cancel().catch(() => {}); }
  }
  drainAudio() {
    if (!this.connected || this.playing) return;
    const next = this.audioQueue.shift();
    if (!next) { this.onStatus(this.receiving ? '正在准备接下来的回应' : '正在听你说'); return; }
    const generation = this.generation, turn = this.turnGeneration;
    this.play(next, generation).catch(error => {
      if (generation === this.generation && turn === this.turnGeneration) { this.interrupt(false); this.onError(error.message); this.onStatus('正在听你说'); }
    });
  }
  trimHistory() {
    this.history = this.history.slice(-20);
    while (this.history.reduce((sum, item) => sum + item.text.length, 0) > 48000) this.history.shift();
  }
  interrupt(notify = true) {
    if (this.playing && this.history.at(-1)?.role === 'assistant') this.history.pop();
    this.turnGeneration++; this.turnController?.abort(); this.audio.pause(); this.playing = false; this.audioQueue = []; this.receiving = false;
    if (notify && this.connected) this.onStatus('正在听你说');
  }
  toggleMute() {
    this.muted = !this.muted; this.microphone?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    this.recording = false; this.chunks = []; this.preRoll = []; this.voiceBlocks = 0; return this.muted;
  }
  disconnect(notify = true) {
    this.generation++; this.connected = false; this.recording = false; this.interrupt(false); this.controller?.abort();
    this.microphone?.getTracks().forEach(track => track.stop()); this.source?.disconnect(); this.worklet?.disconnect(); this.silent?.disconnect();
    this.context?.close().catch(() => {}); this.context = null; this.audio.removeAttribute('src'); this.audio.load();
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; this.microphone = null;
    if (notify) { this.onConnection(false); this.onStatus('对话已结束'); }
  }
}
