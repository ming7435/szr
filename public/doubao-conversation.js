// The backend fixes the cloned speaker. This transport never selects a fallback voice.
export class DoubaoConversation {
  constructor(options) {
    Object.assign(this, options); this.generation = 0; this.sources = new Set(); this.segments = [];
  }
  send(event) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
  async connect(settings = {}) {
    this.disconnect(false); const generation = this.generation;
    const current = () => generation === this.generation;
    this.onStatus('正在连接语音服务');
    try {
      const context = new AudioContext({ sampleRate: 16000 }); this.context = context;
      await context.resume(); if (!current()) return;
      this.videoMode = settings.video === true;
      if (this.videoMode) { await this.renderer.connect(); if (!current()) return; }
      else { this.output = context.createMediaStreamDestination(); this.gain = context.createGain(); this.gain.connect(this.output); this.audio.srcObject = this.output.stream; }
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/doubao/live`);
      this.socket = socket; socket.binaryType = 'arraybuffer'; this.suppressed = true; this.connected = false; this.muted = false;
      await new Promise((resolve, reject) => {
        let handshakeDone = false;
        const timer = setTimeout(() => reject(new Error('实时语音连接超时，请检查本机配置。')), 28000);
        const settle = error => { clearTimeout(timer); this.cancelStartup = null; error ? reject(error) : resolve(); };
        this.cancelStartup = () => settle(new Error('连接已取消。'));
        socket.onopen = () => { if (current()) this.send({ type: 'start', instructions: settings.instructions, guideScene: settings.guideScene }); };
        socket.onerror = () => { if (current()) settle(new Error('无法连接本机实时语音服务。')); };
        socket.onclose = () => {
          if (!current()) return;
          if (!handshakeDone) settle(new Error('实时连接已关闭，请检查配置。'));
          else if (!this.connected) { this.onError('实时连接已关闭，请重新开始。'); this.disconnect(); }
          else { this.disconnect(false); this.onConnection(false); this.onStatus('对话已结束'); }
        };
        socket.onmessage = message => {
          if (!current()) return;
          try {
            if (message.data instanceof ArrayBuffer) { this.enqueue(message.data); return; }
            const event = JSON.parse(message.data);
            if (event.type === 'error') { if (!this.connected) settle(new Error(event.error)); else { this.onError(event.error); this.disconnect(); } return; }
            if (event.type === 'ready') {
              if (event.voice !== 'uploaded-reference' || event.sampleRate !== 24000) { settle(new Error('服务未返回指定音色或音频格式。')); return; }
              handshakeDone = true; settle(); return;
            }
            this.receive(event);
          } catch (error) { if (!this.connected) settle(error); else { this.onError(error.message); this.disconnect(); } }
        };
      });
      if (!current()) return;
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) { microphone.getTracks().forEach(track => track.stop()); return; }
      this.microphone = microphone;
      await context.audioWorklet.addModule('/streaming-microphone-worklet.js'); if (!current()) return;
      this.input = context.createMediaStreamSource(microphone);
      this.worklet = new AudioWorkletNode(context, 'streaming-microphone');
      this.silent = context.createGain(); this.silent.gain.value = 0;
      this.input.connect(this.worklet); this.worklet.connect(this.silent); this.silent.connect(context.destination);
      this.worklet.port.onmessage = event => { if (current()) this.inputFrame(event.data); };
      if (!this.videoMode) await this.onAudio?.(this.output.stream); if (!current()) return;
      this.connected = true; this.onConnection(true); this.onStatus('我正在听');
    } catch (error) {
      if (current()) { this.disconnect(); throw new Error(error.name === 'NotAllowedError' ? '请允许麦克风后再开始对话。' : error.message); }
    }
  }
  inputFrame(samples) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 1048576) { this.onError('网络录音积压，请重新连接。'); this.disconnect(); return; }
    const bytes = new ArrayBuffer(samples.length * 2), view = new DataView(bytes);
    let power = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = this.muted ? 0 : Math.max(-1, Math.min(1, samples[i])); power += sample * sample;
      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    // AEC handles speaker echo; stronger sustained input stops local playback promptly.
    this.loudFrames = !this.muted && (this.sources.size || (this.videoMode && this.renderer.responding)) && Math.sqrt(power / samples.length) > .04 ? (this.loudFrames || 0) + 1 : 0;
    if (this.loudFrames >= 3) this.interrupt();
    this.socket.send(bytes);
  }
  receive(event) {
    if (event.type === 'speech_started') { this.clearAudio(); if (this.videoMode) this.renderer.warm?.(); this.suppressed = true; this.replyId = null; this.questionId = event.questionId; this.onStatus('我正在听'); }
    if (event.type === 'speech_stopped') this.onStatus('正在回应');
    if (event.type === 'response_started') {
      if (this.replyId === event.replyId && !this.suppressed) return;
      this.clearAudio(); this.replyId = event.replyId; this.questionId = event.questionId; this.suppressed = false; this.generating = true; this.segments = []; this.onStatus('正在回应');
      if (this.videoMode) this.renderer.beginReply(event.replyId);
    }
    if (event.type === 'response_ended' && event.replyId === this.replyId && !this.suppressed) { this.generating = false; if (this.videoMode) this.renderer.finish(); else if (!this.sources.size) this.onStatus('我正在听'); }
  }
  enqueue(bytes) {
    if (this.suppressed || !this.context || !this.replyId) return;
    if (bytes.byteLength % 2 || bytes.byteLength > 2 * 1024 * 1024) throw new Error('返回的语音格式不正确。');
    if (this.videoMode) { this.renderer.push(bytes); return; }
    const context = this.context, duration = bytes.byteLength / 2 / 24000;
    const start = Math.max(context.currentTime + .025, this.nextTime || 0);
    // Cloud synthesis can arrive faster than playback. Bound memory without
    // treating an ordinary multi-sentence answer as a connection failure.
    if (start + duration - context.currentTime > 90) throw new Error('声音播放积压，请重新连接。');
    const buffer = context.createBuffer(1, bytes.byteLength / 2, 24000), channel = buffer.getChannelData(0), view = new DataView(bytes);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    this.sources.add(source); this.segments.push({ start, duration }); this.nextTime = start + duration;
    const generation = this.generation, replyId = this.replyId;
    source.onended = () => { this.sources.delete(source); source.disconnect(); if (generation === this.generation && replyId === this.replyId && !this.sources.size && !this.generating && !this.suppressed) this.onStatus('我正在听'); };
    source.start(start); this.onStatus('我正在回应');
    context.resume().catch(() => {});
    this.audio.play().catch(() => { if (generation === this.generation && !this.suppressed) this.onError('请点击「开启声音」允许播放。'); });
  }
  clearAudio() {
    if (this.videoMode) this.renderer.clear();
    for (const source of this.sources) { source.onended = null; try { source.stop(); source.disconnect(); } catch {} }
    this.sources.clear(); this.audio.pause(); this.nextTime = 0; this.generating = false; this.loudFrames = 0;
  }
  interrupt() {
    const time = this.context?.currentTime || 0;
    const audioEndMs = this.videoMode ? this.renderer.heardMilliseconds() : Math.round(this.segments.reduce((sum, segment) => sum + Math.max(0, Math.min(segment.duration, time - segment.start)), 0) * 1000);
    this.clearAudio(); this.suppressed = true; this.send({ type: 'interrupt', replyId: this.replyId, questionId: this.questionId, audioEndMs: Math.min(900000, audioEndMs) }); this.onStatus('我正在听');
  }
  toggleMute() { this.muted = !this.muted; this.microphone?.getAudioTracks().forEach(track => { track.enabled = !this.muted; }); this.send({ type: 'mute', muted: this.muted }); return this.muted; }
  disconnect(notify = true) {
    this.generation++; this.cancelStartup?.(); this.cancelStartup = null; this.clearAudio(); this.suppressed = true;
    this.send({ type: 'stop' }); this.socket?.close(); this.socket = null;
    this.renderer?.disconnect(); this.videoMode = false;
    this.microphone?.getTracks().forEach(track => track.stop()); this.microphone = null;
    this.input?.disconnect(); this.worklet?.disconnect(); this.silent?.disconnect(); this.gain?.disconnect();
    this.context?.close().catch(() => {}); this.context = null; this.audio.srcObject = null; this.connected = false; this.replyId = null; this.questionId = null; this.segments = [];
    if (notify) { this.onConnection(false); this.onStatus('对话已结束'); }
  }
}
