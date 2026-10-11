export class RealtimeConversation {
  constructor({ audio, onStatus = () => {}, onMessage = () => {}, onError = () => {}, onConnection = () => {}, onAudio = () => {}, onInterruption = () => {}, onToolCall = async () => ({ status: 'unsupported', saved: false }) }) {
    Object.assign(this, { audio, onStatus, onMessage, onError, onConnection, onAudio, onInterruption, onToolCall });
    this.transcripts = new Map(); this.responseItems = new Map(); this.cancelled = new Set(); this.generation = 0; this.generating = false; this.playing = false; this.userSpeaking = false;
    this.toolCalls = new Set();
  }
  async connect(settings) {
    this.disconnect(false);
    const generation = this.generation;
    this.transcripts.clear(); this.responseItems.clear(); this.cancelled.clear(); this.toolCalls.clear();
    const peer = new RTCPeerConnection(); this.peer = peer;
    const controller = new AbortController(); this.controller = controller;
    const current = () => generation === this.generation;
    const check = () => { if (!current()) throw new Error('连接已取消。'); };
    this.onStatus('正在连接语音空间', '请允许麦克风权限，连接后直接说话。');
    peer.addEventListener('track', async event => {
      if (!current()) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.audio.srcObject = stream;
      try { await this.onAudio(stream); await this.audio.play(); }
      catch { this.onError('浏览器暂停了声音，请点击「开启声音」。'); document.getElementById('audio-resume')?.removeAttribute('hidden'); }
    });
    peer.addEventListener('connectionstatechange', () => {
      if (!current()) return;
      if (peer.connectionState === 'failed') { this.disconnect(); this.onError('实时连接中断，请检查网络后重新连接。'); }
      if (peer.connectionState === 'disconnected') this.disconnectedTimer = setTimeout(() => { if (current() && peer.connectionState === 'disconnected') { this.disconnect(); this.onError('网络连接已断开，请重新连接。'); } }, 8000);
      if (peer.connectionState === 'connected') clearTimeout(this.disconnectedTimer);
    });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法使用麦克风，请用 Chrome 或 Edge 打开本机地址。');
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!current()) { microphone.getTracks().forEach(track => track.stop()); check(); }
      this.microphone = microphone;
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
      const channel = peer.createDataChannel('oai-events'); this.channel = channel;
      channel.addEventListener('message', event => { if (!current()) return; try { this.handleEvent(JSON.parse(event.data)); } catch { this.onError('收到无法读取的对话事件。'); } });
      channel.addEventListener('close', () => { if (current() && this.connected) { this.disconnect(); this.onError('对话连接已关闭，请重新连接。'); } });
      const offer = await peer.createOffer(); check(); await peer.setLocalDescription(offer); check();
      const response = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sdp: offer.sdp, ...settings }), signal: controller.signal }); check();
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '无法建立语音会话。');
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp }); check();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('语音连接超时，请检查网络后重试。')); }, 20000);
        const opened = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('语音连接在建立过程中关闭。')); };
        const cleanup = () => { clearTimeout(timeout); channel.removeEventListener('open', opened); channel.removeEventListener('close', closed); controller.signal.removeEventListener('abort', closed); };
        channel.addEventListener('open', opened); channel.addEventListener('close', closed); controller.signal.addEventListener('abort', closed, { once: true });
        if (channel.readyState === 'open') opened(); else if (channel.readyState === 'closed' || controller.signal.aborted) closed();
      }); check();
      this.connected = true; this.muted = false; this.onConnection(true); this.onStatus('正在听你说', '你好，我准备好了。想聊些什么？');
    } catch (error) {
      if (current()) this.disconnect();
      if (error.name === 'NotAllowedError') throw new Error('麦克风权限被拒绝，请在浏览器中允许麦克风后重试。');
      if (error.name === 'NotFoundError') throw new Error('没有找到麦克风，请连接麦克风后重试。');
      if (error.name === 'AbortError') throw new Error('连接已取消。');
      throw error;
    }
  }
  disconnect(notify = true) {
    this.generation++; this.connected = false; this.generating = false; this.playing = false; this.userSpeaking = false;
    clearTimeout(this.disconnectedTimer); this.controller?.abort();
    this.microphone?.getTracks().forEach(track => track.stop()); this.channel?.close(); this.peer?.close();
    this.audio.pause(); this.audio.srcObject = null; this.channel = null; this.peer = null; this.microphone = null; this.responseId = null;
    if (notify) { this.onConnection(false); this.onStatus('对话已结束', '很高兴和你聊天，随时可以再来。'); }
  }
  send(event) {
    if (this.channel?.readyState !== 'open') throw new Error('对话连接尚未就绪。');
    this.channel.send(JSON.stringify(event));
  }
  sendText(text) {
    if (this.generating || this.playing) this.interrupt();
    const id = `item_${crypto.randomUUID().replaceAll('-', '')}`;
    this.onMessage('user', text, id, false); this.transcripts.set(id, text);
    this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' }); this.onStatus('正在思考你的问题');
  }
  toggleMute() { this.muted = !this.muted; this.microphone?.getAudioTracks().forEach(track => { track.enabled = !this.muted; }); return this.muted; }
  markInterrupted() {
    if (this.responseId) this.cancelled.add(this.responseId);
    if ((this.generating || this.playing) && this.responseItems.has(this.responseId)) this.onInterruption(this.responseItems.get(this.responseId));
    this.generating = false; this.playing = false;
  }
  interrupt() {
    if (this.channel?.readyState !== 'open') return;
    if (this.generating && this.responseId) this.send({ type: 'response.cancel', response_id: this.responseId });
    if (this.playing || this.responseId) this.send({ type: 'output_audio_buffer.clear' });
    this.markInterrupted(); this.onStatus('正在听你说', '你可以继续说，我在听。');
  }
  handleEvent(event) {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.markInterrupted(); this.userSpeaking = true;
        if (event.item_id) this.onMessage('user', '', event.item_id, true);
        this.onStatus('你在说，我在听', '正在聆听…'); break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false; this.onStatus('正在思考你的问题'); break;
      case 'conversation.item.input_audio_transcription.delta': {
        const text = (this.transcripts.get(event.item_id) || '') + (event.delta || ''); this.transcripts.set(event.item_id, text);
        this.onMessage('user', text, event.item_id, true); break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.transcripts.set(event.item_id, event.transcript || ''); this.onMessage('user', event.transcript || '（未识别到清晰语音）', event.item_id, false); break;
      case 'conversation.item.input_audio_transcription.failed':
        this.onMessage('user', '（这段语音未能识别，请再说一次）', event.item_id, false); break;
      case 'response.created':
        this.responseId = event.response?.id; this.generating = true; this.userSpeaking = false; this.onStatus('正在思考你的问题'); break;
      case 'response.output_item.added':
        if (event.response_id && event.item?.id) this.responseItems.set(event.response_id, event.item.id); break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        if (this.cancelled.has(event.response_id)) return;
        const id = event.item_id || event.response_id; this.responseItems.set(event.response_id, id); const text = (this.transcripts.get(id) || '') + (event.delta || ''); this.transcripts.set(id, text);
        this.onMessage('assistant', text, id, true); this.onStatus('我正在回应', text.slice(-72)); break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        if (this.cancelled.has(event.response_id)) return;
        const id = event.item_id || event.response_id; const text = event.transcript || this.transcripts.get(id) || ''; this.transcripts.set(id, text);
        this.onMessage('assistant', text, id, false); break;
      }
      case 'output_audio_buffer.started':
        if (!this.cancelled.has(event.response_id)) { this.playing = true; this.onStatus('我正在回应'); } break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.playing = false; if (!this.userSpeaking && !this.generating) this.onStatus('正在听你说'); break;
      case 'response.done':
        if (event.response?.id === this.responseId) this.generating = false;
        if (event.response?.status === 'failed') this.onError('AI 未能完成回答，请再试一次。');
        if (!this.playing && !this.userSpeaking && !this.cancelled.has(event.response?.id)) this.onStatus('正在听你说');
        if (event.response?.status === 'completed' && !this.cancelled.has(event.response.id)) this.handleTools(event.response.output || []);
        break;
      case 'error':
        if (event.error?.code !== 'response_cancel_not_active') this.onError('对话服务遇到问题，请稍后重试。'); break;
    }
  }
  async handleTools(output) {
    const calls = output.filter(item => item.type === 'function_call' && item.call_id && !this.toolCalls.has(item.call_id));
    if (!calls.length) return;
    calls.forEach(item => this.toolCalls.add(item.call_id));
    const generation = this.generation;
    for (const call of calls) {
      let result;
      try { result = await this.onToolCall(call.name, JSON.parse(call.arguments)); }
      catch { result = { status: 'invalid_request', saved: false }; }
      if (generation !== this.generation || this.channel?.readyState !== 'open') return;
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) } });
    }
    if (!this.userSpeaking && !this.generating) this.send({ type: 'response.create' });
  }
}
