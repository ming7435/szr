import { PCMResampler } from './pcm-resampler.js';

// One video element plays the returned WebRTC sound and video with a shared clock.
export class SimliVideo {
  constructor(options) { Object.assign(this, options); this.generation = 0; this.resampler = new PCMResampler(); this.pending = []; }
  get responding() { return !!this.replyId && (this.fed || this.speaking || this.awaitingOutput || this.pending.length > 0); }
  async connect() {
    this.disconnect(); return this.open();
  }
  async open() {
    const generation = this.generation, current = () => generation === this.generation;
    this.controller = new AbortController(); this.onStatus?.('正在连接实时人像');
    try {
      const response = await fetch('/api/simli/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: this.controller.signal });
      const session = await response.json(); if (!current()) return;
      if (!response.ok) throw new Error(session.error || '实时人像连接未完成。');
      if (session.sampleRate !== 16000 || typeof session.sessionToken !== 'string' || !Array.isArray(session.iceServers)) throw new Error('实时人像连接配置无效。');
      this.initializing = true;
      this.stream = new MediaStream(); this.video.srcObject = this.stream; this.video.muted = true;
      const peer = new RTCPeerConnection({ iceServers: session.iceServers }); this.peer = peer;
      peer.addTransceiver('audio', { direction: 'recvonly' }); peer.addTransceiver('video', { direction: 'recvonly' });
      const url = new URL('wss://api.simli.ai/compose/webrtc/p2p'); url.searchParams.set('session_token', session.sessionToken); url.searchParams.set('enableSFU', 'true');
      const socket = new WebSocket(url); this.socket = socket;
      const ready = new Promise((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; this.startTimer = setTimeout(() => this.fail('实时人像连接超时，请检查网络、人像模型和试用额度。'), 30000); });
      peer.ontrack = event => {
        if (!current()) { event.track.stop(); return; }
        if (!this.stream.getTracks().some(track => track.id === event.track.id)) this.stream.addTrack(event.track);
        event.track.onended = () => { if (current()) this.fail('实时人像流已结束，请重新连接。'); };
        this.video.play().catch(() => { if (current()) this.fail('浏览器无法播放实时人像，请重新开始对话。'); });
        if (this.stream.getAudioTracks().length && this.stream.getVideoTracks().length && !this.frameRequested) {
          this.frameRequested = true;
          this.frameCallback = this.video.requestVideoFrameCallback(() => {
            if (!current()) return;
            clearTimeout(this.startTimer); this.startReject = null;
            this.video.hidden = false; this.stage.classList.add('live-video'); this.onMode?.(true);
            this.startResolve?.(); this.startResolve = null;
          });
        }
      };
      peer.onconnectionstatechange = () => { if (current() && ['failed', 'disconnected', 'closed'].includes(peer.connectionState)) this.fail('实时人像网络连接中断，请重新开始。'); };
      socket.onerror = () => { if (current()) this.fail('无法连接实时人像服务，请检查网络。'); };
      socket.onclose = () => { if (current()) this.fail('实时人像连接已关闭，请重新开始。'); };
      socket.onmessage = event => { if (current()) this.receive(event.data).catch(() => { if (current()) this.fail('实时人像信令格式异常，请重新连接。'); }); };
      socket.onopen = async () => {
        try {
          await peer.setLocalDescription(await peer.createOffer()); if (!current()) return;
          if (peer.iceGatheringState !== 'complete') await new Promise(resolve => {
            const timer = setTimeout(finish, 4000);
            function finish() { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); }
            function changed() { if (peer.iceGatheringState === 'complete') finish(); }
            peer.addEventListener('icegatheringstatechange', changed);
            this.controller.signal.addEventListener('abort', finish, { once: true });
          });
          if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(peer.localDescription));
        } catch { if (current()) this.fail('浏览器无法建立实时人像连接。'); }
      };
      await ready; if (!current()) return;
      await this.monitorOutput(generation); if (!current()) return;
      await this.onAudio?.(this.stream);
      if (!current()) return;
      this.ready = true; this.initializing = false;
      const pending = this.pending; this.pending = []; this.pendingBytes = 0;
      for (const entry of pending) this.write(entry.bytes, entry.tail);
      this.onReconnecting?.(false);
    } catch (error) { if (current()) { this.stopTransport(); throw error; } }
  }
  async monitorOutput(generation) {
    const context = new AudioContext(); this.monitor = context;
    await context.resume(); if (generation !== this.generation) return;
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    this.monitorSource = context.createMediaStreamSource(this.stream); this.monitorSource.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.monitorTimer = setInterval(() => {
      if (generation !== this.generation || !this.replyId || this.video.paused || this.video.muted) return;
      analyser.getFloatTimeDomainData(samples);
      let power = 0; for (const value of samples) power += value * value;
      if (Math.sqrt(power / samples.length) > .001) {
        this.quietSince = null;
        if (this.playStarted === null) this.playStarted = this.video.currentTime;
        if (!this.speaking) { this.speaking = true; this.onPlayback?.(true); }
      } else {
        this.quietSince ??= context.currentTime;
        // Silence signals travel on a different link. Finish only after actual
        // audible output has traversed the receiver's playback clock and gone quiet.
        if (this.inputFinished && this.playStarted !== null && this.video.currentTime - this.playStarted >= this.sentSeconds && context.currentTime - this.quietSince > .2) {
          const active = this.fed || this.speaking || this.awaitingOutput;
          this.fed = false; this.speaking = false; this.awaitingOutput = false;
          if (active) this.onPlayback?.(false);
        }
      }
    }, 40);
  }
  fail(message) {
    if (this.startReject) { this.startReject(new Error(message)); this.startReject = null; }
    else if (this.ready || this.initializing) { this.stopTransport(); this.onError?.(message); }
  }
  async receive(message) {
    if (typeof message !== 'string' || message.length > 131072) throw new Error();
    if (message.startsWith('{')) { const answer = JSON.parse(message); if (answer.type === 'answer' && typeof answer.sdp === 'string') await this.peer.setRemoteDescription(answer); return; }
    const signal = message.toUpperCase().split(' ')[0];
    if (['STOP', 'CLOSING', 'RATE', 'ERROR', 'ERROR:', 'ENDFRAME'].includes(signal)) { this.fail('实时人像服务停止，请检查试用额度及人像状态。'); return; }
    // SPEAK/SILENT are hints, not playback completion or a SKIP acknowledgement.
    if (signal === 'SPEAK') this.serviceSilent = false;
    if (signal === 'SILENT') this.serviceSilent = true;
  }
  beginReply(replyId) { this.replyId = replyId; this.resampler.reset(); this.sentSeconds = 0; this.playStarted = null; this.quietSince = null; this.inputFinished = false; this.pending = []; this.pendingBytes = 0; }
  push(bytes) { if (this.replyId) this.write(this.resampler.push(new Uint8Array(bytes))); }
  finish() { if (this.replyId) { this.inputFinished = true; this.write(this.resampler.flush(), true); } }
  write(bytes, tail = false) {
    if (!bytes.byteLength) return;
    if (!this.ready) { this.pendingBytes = (this.pendingBytes || 0) + bytes.byteLength; if (this.pendingBytes > 90 * 32000) throw new Error('实时声画缓冲积压，请重新连接。'); this.pending.push({ bytes, tail }); return; }
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 1048576) throw new Error('实时人像音频发送积压，请重新连接。');
    this.fed = true; this.everFed = true; if (!tail) this.awaitingOutput = true; this.sentSeconds = (this.sentSeconds || 0) + bytes.byteLength / 32000;
    if (this.sentSeconds - this.heardMilliseconds() / 1000 > 90) throw new Error('实时声画播放积压，请重新连接。');
    for (let offset = 0; offset < bytes.byteLength; offset += 6400) this.socket.send(bytes.subarray(offset, offset + 6400));
    this.video.muted = false; this.resume();
  }
  heardMilliseconds() {
    // Conservative estimate of playout, rather than audio merely sent to the engine.
    return this.playStarted === null || this.playStarted === undefined ? 0 : Math.round(Math.min(this.sentSeconds || 0, Math.max(0, this.video.currentTime - this.playStarted)) * 1000);
  }
  clear() {
    this.video.muted = true; this.video.pause(); this.resampler.reset(); this.pending = []; this.pendingBytes = 0; this.replyId = null; this.playStarted = null;
    const dirty = this.everFed; this.fed = false; this.speaking = false; this.awaitingOutput = false;
    if (dirty && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send('SKIP'); this.onReconnecting?.(true); this.stopTransport();
      // Detach and close the old receiver. New replies can never resurrect its
      // queued RTP frames; reconnect while the user is saying the next question.
      const restart = this.open(); this.restart = restart;
      restart.catch(error => { if (this.restart === restart) this.onError?.(error.message); });
    }
  }
  resume() { const generation = this.generation; if (this.ready) this.video.play().catch(() => { if (generation === this.generation) this.onError?.('请点击「开启声音」允许播放。'); }); }
  stopTransport() {
    this.generation++; this.controller?.abort(); this.controller = null;
    this.startReject?.(new Error('视频连接已取消。')); this.startReject = null; this.startResolve = null;
    clearTimeout(this.startTimer); clearInterval(this.monitorTimer); this.monitorSource?.disconnect(); this.monitorSource = null; this.monitor?.close().catch(() => {}); this.monitor = null;
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
    if (this.socket) { this.socket.onopen = null; this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null; if (this.socket.readyState === WebSocket.OPEN) this.socket.send('DONE'); this.socket.close(); } this.socket = null;
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); } this.peer = null;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    this.video.muted = true; this.video.pause(); this.video.srcObject = null; this.video.hidden = true; this.stage.classList.remove('live-video'); this.onMode?.(false);
    this.ready = false; this.initializing = false; this.frameRequested = false; this.everFed = false;
  }
  disconnect() {
    this.stopTransport(); this.onReconnecting?.(false); this.restart = null;
    this.pending = []; this.pendingBytes = 0; this.resampler.reset(); this.replyId = null;
    this.fed = false; this.speaking = false; this.awaitingOutput = false; this.playStarted = null; this.inputFinished = false;
  }
}
