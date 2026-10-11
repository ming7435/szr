export class ProConversation {
  constructor({ onState, onMessage, onStatus, onError, onFailure, onBusy, onAuthorization }) {
    Object.assign(this, { onState, onMessage, onStatus, onError, onFailure, onBusy, onAuthorization });
    this.session = { status: 'disconnected', sharing: false }; this.models = []; this.generation = 0;
  }
  async json(url, options) {
    const response = await fetch(url, options); const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本次连接未完成，请重试。'); return result;
  }
  async load() {
    const generation = this.generation;
    try {
      const session = await this.json('/api/chatgpt/session');
      if (generation !== this.generation) return;
      this.session = session; this.onState(session, this.models);
      if (session.sharing && session.status !== 'connecting' && !this.models.length) {
        try { const result = await this.json('/api/chatgpt/models'); if (generation !== this.generation) return; this.models = result.models; this.onState(session, this.models); }
        catch (error) { this.onError(error.message); this.onState({ ...session, error: error.message }, []); }
      }
      if (session.status === 'connecting') this.schedulePoll();
      else if (this.loginBusy) { this.loginBusy = false; this.onAuthorization(null); if (session.error) this.onError(session.error); }
    } catch (error) { this.loginBusy = false; this.onAuthorization(null); this.onState({ status: 'disconnected', sharing: false, error: '本机对话服务尚未就绪，请刷新重试。' }, []); }
  }
  schedulePoll() { clearTimeout(this.pollTimer); this.pollTimer = setTimeout(() => this.load(), 2000); }
  async signIn() {
    if (this.loginBusy) return;
    this.loginBusy = true; const generation = ++this.generation; this.models = [];
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    this.onState({ ...this.session, status: 'connecting' }, []);
    try {
      const result = await this.json('/api/chatgpt/signin', { method: 'POST' });
      if (generation !== this.generation) { popup?.close(); return; }
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') throw new Error('登录链接校验未通过，请重试。');
      this.onAuthorization(url.href);
      if (popup && !popup.closed) popup.location = url.href;
      this.schedulePoll();
    } catch (error) { popup?.close(); if (generation !== this.generation) return; this.loginBusy = false; this.onError(error.message); await this.load(); }
  }
  async cancelSignIn() { this.generation++; clearTimeout(this.pollTimer); this.loginBusy = false; this.onAuthorization(null); await this.json('/api/chatgpt/cancel', { method: 'POST' }); await this.load(); }
  async disconnect() { this.abort(); this.generation++; clearTimeout(this.pollTimer); this.models = []; this.loginBusy = false; this.onAuthorization(null); await this.json('/api/chatgpt/signout', { method: 'POST' }); await this.load(); }
  abort() { this.request?.abort(); }
  async send(text, history, instructions, model) {
    if (this.request) return this.onError('请等待当前回答，或先停止回答。');
    if (!this.session.sharing || !this.models.length) return this.onError('请先使用 ChatGPT 登录并载入可用模型。');
    const controller = new AbortController(); this.request = controller; this.onBusy(true);
    const id = crypto.randomUUID();
    this.onMessage('user', text); this.onMessage('assistant', '', id, true); this.onStatus('正在思考', '正在等待回答…');
    let responseText = '', completed = false, reader;
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ messages: [...history, { role: 'user', text }].slice(-40), instructions, model: model || this.models[0].slug }) });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || '发送失败，请重试。'); }
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      const receive = line => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'delta') { responseText += event.delta; this.onMessage('assistant', responseText, id, true); this.onStatus('正在回应', responseText.slice(-80)); }
        if (event.type === 'error') throw new Error(event.error || '回答未完成，请重试。');
        if (event.type === 'done') { responseText = event.text; completed = true; this.onMessage('assistant', responseText, id, false); }
      };
      while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let end; while ((end = buffer.indexOf('\n')) >= 0) { receive(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } }
      buffer += decoder.decode(); if (buffer.trim()) receive(buffer);
      controller.signal.throwIfAborted();
      if (!completed || !responseText.trim()) throw new Error('连接中断，回答尚未完成，请重试。');
      this.session.verified = true; this.onState(this.session, this.models); this.onStatus('文字对话已就绪', responseText.slice(-80));
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.onFailure(id, cancelled ? '已停止回答' : error.message, cancelled);
      this.onStatus('文字对话已就绪', cancelled ? '回答已停止，你可以继续提问。' : '本次回答未完成，可以重新发送消息。');
      if (!cancelled) this.onError(error.message);
    } finally { await reader?.cancel().catch(() => {}); if (this.request === controller) this.request = null; this.onBusy(false); }
  }
  dispose() { this.abort(); clearTimeout(this.pollTimer); }
}
