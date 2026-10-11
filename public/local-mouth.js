// Real model frames, paired with unchanged PCM, scheduled on one audio clock.
export class LocalMouth {
  constructor(options) { Object.assign(this, options); this.epoch = 0; this.connection = 0; this.sources = new Set(); this.pending = []; this.timeline = []; this.segments = []; }
  get responding() { return !!this.replyId && (!this.finished || this.sources.size > 0 || this.pending.length > 0 || this.pumping); }
  send(event) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event)); }
  async connect() {
    this.disconnect(); const connection = this.connection;
    try {
      this.onStatus?.('正在准备实时口型');
      const context = new AudioContext({ sampleRate: 24000 }); this.context = context; await context.resume();
      if (connection !== this.connection) return;
      await this.image.decode(); if (connection !== this.connection) return;
      this.canvas.width = this.image.naturalWidth; this.canvas.height = this.image.naturalHeight;
      this.painter = this.canvas.getContext('2d');
      this.gain = context.createGain(); this.gain.connect(context.destination);
      this.output = context.createMediaStreamDestination(); this.gain.connect(this.output);
      // This element feeds the existing volume display only. WebAudio owns sound.
      this.audio.srcObject = this.output.stream; this.audio.muted = true;
      this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/avatar/live`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('本机口型准备超时，请重新开始。')), 65000);
        const settle = error => { clearTimeout(timer); this.cancelStartup = null; error ? reject(error) : resolve(); };
        this.cancelStartup = () => settle(new Error('连接已取消。'));
        this.socket.onerror = () => { if (connection === this.connection) settle(new Error('本机口型连接失败。')); };
        this.socket.onclose = () => { if (connection === this.connection) { if (!this.ready) settle(new Error('本机口型连接已关闭。')); else this.fail('本机口型连接中断，请重新开始。'); } };
        this.socket.onmessage = event => {
          if (connection !== this.connection) return;
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'error') { if (!this.ready) settle(new Error(data.error)); else this.fail(data.error); return; }
            if (data.type === 'ready') {
              if (data.sampleRate !== 24000 || ![20,25].includes(data.fps) || !Array.isArray(data.region) || data.region.length !== 4 || data.region.some(n => !Number.isInteger(n) || n < 0) || data.imageSize?.[0] !== this.canvas.width || data.imageSize?.[1] !== this.canvas.height) throw new Error('本机口型与当前照片不匹配。');
              this.region = data.region; this.fps = data.fps; this.ready = true; settle(); return;
            }
            this.receive(data);
          } catch (error) { if (!this.ready) settle(error); else this.fail(error.message); }
        };
      });
      if (connection !== this.connection) return;
      this.warm();
      await this.audio.play(); await this.onAudio?.(this.output.stream);
      if (connection !== this.connection) return;
      this.timer = setInterval(() => this.pump(), 20);
      this.animate();
    } catch (error) { if (connection === this.connection) { this.disconnect(); throw error; } }
  }
  beginReply(replyId) {
    this.clear(); this.replyId = replyId; this.finished = false; this.receivedIndex = 0;
    this.send({ type: 'begin', replyId });
  }
  warm() { if (this.ready && !this.replyId) this.send({ type: 'warm' }); }
  push(bytes) {
    if (!this.replyId || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) { this.fail('本机口型音频积压，请重新开始。'); return; }
    this.socket.send(bytes);
  }
  finish() { if (this.replyId) this.send({ type: 'finish' }); }
  receive(event) {
    if (!this.replyId || event.replyId !== this.replyId) return;
    if (event.type === 'finished') { this.finished = true; return; }
    if (event.type !== 'frame' || event.index !== this.receivedIndex || event.index >= 90*(this.fps || 25) || typeof event.pcm !== 'string' || event.pcm.length > (this.fps === 20 ? 3200 : 2560) || typeof event.jpeg !== 'string' || event.jpeg.length > 250000) throw new Error('本机口型画面格式异常。');
    this.receivedIndex++; this.pending.push(event); this.pump();
  }
  async pump() {
    if (this.pumping || !this.context || !this.replyId || !this.pending.length || (this.nextTime || 0) - this.context.currentTime > 2) return;
    const epoch = this.epoch, replyId = this.replyId, context = this.context;
    this.pumping = true;
    try {
      while (epoch === this.epoch && replyId === this.replyId && this.pending.length && (this.nextTime || 0) - context.currentTime <= 2) {
        const event = this.pending.shift();
        const jpeg = Uint8Array.from(atob(event.jpeg), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
        if (epoch !== this.epoch || replyId !== this.replyId) { bitmap.close(); return; }
        const bytes = Uint8Array.from(atob(event.pcm), character => character.charCodeAt(0));
        if (!bytes.length || bytes.length % 2 || bytes.length > 48000/(this.fps || 25)) { bitmap.close(); throw new Error('口型音频格式异常。'); }
        const duration = bytes.length / 2 / 24000;
        // Keep queued PCM contiguous. Add the startup cushion once, then only
        // move the clock forward if a real underrun needs recovery.
        const buffer = context.createBuffer(1, bytes.length / 2, 24000), channel = buffer.getChannelData(0), view = new DataView(bytes.buffer);
        let power = 0;
        for (let i = 0; i < channel.length; i++) { channel[i] = view.getInt16(i * 2, true) / 32768; power += channel[i] * channel[i]; }
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
        const now=context.currentTime;
        const start=this.nextTime > now ? this.nextTime : now+(this.nextTime ? .01 : this.fps === 20 ? .2 : .075);
        this.sources.add(source); this.timeline.push({ start, duration, bitmap, index: event.index, energy: Math.sqrt(power / channel.length) }); this.segments.push({ start, duration }); this.nextTime = start + duration;
        source.onended = () => { this.sources.delete(source); source.disconnect(); };
        source.start(start); this.audio.play().catch(() => {}); this.onPlayback?.(true);
      }
    } catch (error) { if (epoch === this.epoch && replyId === this.replyId) this.fail(error.message || '实时口型播放失败。'); }
    finally { if (epoch === this.epoch && replyId === this.replyId) this.pumping = false; }
  }
  clock() { return this.context?.getOutputTimestamp?.().contextTime || this.context?.currentTime || 0; }
  paint(frame, mix = 1) {
    const [x,y,w,h] = this.region;
    if (mix < 1) {
      const previous = this.previousFrame;
      if (previous?.index === frame.index - 1 && Math.abs(previous.start + previous.duration - frame.start) < .025) this.painter.drawImage(previous.bitmap, ...this.region);
      else this.painter.drawImage(this.image, x,y,w,h,x,y,w,h);
    }
    this.painter.globalAlpha = mix;
    this.painter.drawImage(frame.bitmap, ...this.region);
    this.painter.globalAlpha = 1;
  }
  animate() {
    if (!this.context) return;
    const time = this.clock();
    let frame;
    while (this.timeline.length && this.timeline[0].start + this.timeline[0].duration <= time) {
      this.previousFrame?.bitmap.close(); this.previousFrame = this.timeline.shift();
    }
    if (this.timeline[0]?.start <= time) frame = this.timeline[0];
    if (frame) {
      // Causal, short visual transition; PCM and the audible frame index never change.
      const mix = Math.min(1, Math.max(0, (time - frame.start) / Math.min(.024, frame.duration * .5)));
      if (this.drawnIndex !== frame.index || this.canvas.hidden || this.drawnMix !== mix) {
        // The background is immutable during this connection. Paint it once;
        // subsequent complete mouth patches do not need a full-photo redraw.
        const firstFrame = this.canvas.hidden;
        if (firstFrame) this.painter.drawImage(this.image, 0, 0);
        this.paint(frame, mix);
        this.canvas.dataset.frameIndex = String(frame.index); this.canvas.dataset.replyId = this.replyId;
        this.canvas.dataset.audioEnergy = frame.energy.toFixed(5);
        if (this.drawnIndex !== frame.index) this.frameCount = (this.frameCount || 0) + 1;
        this.drawnIndex = frame.index; this.drawnMix = mix; this.visualFrameCount = (this.visualFrameCount || 0) + 1;
        this.canvas.hidden = false; this.stage.classList.add('local-mouth'); if (firstFrame) this.onMode?.(true);
      }
    } else if (this.canvas && !this.canvas.hidden) {
      const previous = this.previousFrame;
      const elapsed = previous ? time - previous.start - previous.duration : Infinity;
      const ending = this.finished && !this.pending.length && !this.pumping && !this.sources.size;
      this.canvas.dataset.audioEnergy = '0';
      if (previous && elapsed >= 0 && elapsed < (ending ? .08 : .12)) {
        if (ending) {
          const [x,y,w,h] = this.region;
          this.painter.drawImage(previous.bitmap, ...this.region);
          this.painter.globalAlpha = elapsed / .08;
          this.painter.drawImage(this.image,x,y,w,h,x,y,w,h); this.painter.globalAlpha = 1;
        }
      } else this.hide();
    }
    if (this.replyId && this.finished && !this.pending.length && !this.pumping && !this.sources.size && !this.timeline.length && this.canvas.hidden) { this.replyId = null; this.onPlayback?.(false); }
    this.animation = requestAnimationFrame(() => this.animate());
  }
  heardMilliseconds() { const time = this.clock(); return Math.round(this.segments.reduce((sum, part) => sum + Math.max(0, Math.min(part.duration, time - part.start)), 0) * 1000); }
  hide() { this.previousFrame?.bitmap.close(); this.previousFrame = null; this.canvas.dataset.audioEnergy = '0'; this.canvas.hidden = true; this.stage.classList.remove('local-mouth'); this.onMode?.(false); }
  clear() {
    this.epoch++; this.send({ type: 'clear' }); this.replyId = null; this.finished = true; this.pending = []; this.pumping = false;
    for (const source of this.sources) { source.onended = null; try { source.stop(); source.disconnect(); } catch {} }
    this.sources.clear(); for (const frame of this.timeline) frame.bitmap.close(); this.timeline = []; this.segments = []; this.nextTime = 0; this.drawnIndex = null; this.drawnMix = null;
    this.hide();
  }
  fail(message) { this.clear(); this.onError?.(message || '本机口型播放失败。'); }
  resume() { return this.context?.resume(); }
  disconnect() {
    this.connection++; this.cancelStartup?.(); this.cancelStartup = null; this.clear(); this.ready = false;
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close(); } this.socket = null;
    clearInterval(this.timer); cancelAnimationFrame(this.animation);
    this.gain?.disconnect(); this.output?.stream.getTracks().forEach(track => track.stop()); this.context?.close().catch(() => {}); this.context = null;
    this.audio.pause(); this.audio.srcObject = null; this.audio.muted = false;
  }
}
