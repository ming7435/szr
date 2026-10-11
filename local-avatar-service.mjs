import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export class LocalAvatarService {
  constructor(root, options = {}) {
    this.root = root; this.options = options;
    this.python = path.join(root, '.runtime/avatar-env/Scripts/python.exe');
    this.model = path.join(root, '.runtime/avatar-model/native.xml');
    this.ready = null;
  }
  publicConfig() {
    const available = this.options.available ?? (existsSync(this.python) && existsSync(this.model) &&
      existsSync(path.join(this.root, '.runtime/avatar-model/native.bin')) &&
      existsSync(path.join(this.root, '.runtime/avatar-model/native-source.json')) &&
      existsSync(path.join(this.root, '.runtime/avatar-model/yunet.onnx')));
    return { available, enabled: available, ready: !!this.ready, mode: 'local-mouth', expressions: 'basic-eye-brow', lowerFaceMotion: available, personalTestingOnly: true };
  }
  prepare() {
    if (this.preparing) return this.preparing;
    if (!this.publicConfig().available) return Promise.reject(new Error('本机口型模型尚未准备好。'));
    this.preparing = new Promise((resolve, reject) => {
      let settled = false, buffer = '';
      const timer = setTimeout(() => { this.worker?.kill(); fail(); }, 60000); timer.unref();
      const fail = () => {
        if (this.worker !== worker) return;
        clearTimeout(timer); this.worker = null; this.ready = null; this.preparing = null;
        if (!settled) { settled = true; reject(new Error('本机口型模型加载失败，请重新连接。')); }
        if (this.client) { this.send({ type: 'error', error: '本机口型服务中断，请重新开始。' }); this.client.close(); }
      };
      const worker = (this.options.spawn || spawn)(this.python, ['-u', path.join(this.root, 'scripts/avatar-worker.py'), this.root], { cwd: this.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OPENVINO_TELEMETRY_OPT_IN: '0' } });
      this.worker = worker;
      worker.stderr.on('data', () => {});
      worker.stdin.on?.('error', fail);
      worker.on('error', fail); worker.on('exit', fail);
      worker.stdout.on('data', data => {
        if (this.worker !== worker) return;
        buffer += data.toString('utf8');
        if (buffer.length > 4 * 1024 * 1024) { worker.kill(); return fail(); }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'ready' && !settled) { settled = true; clearTimeout(timer); this.ready = event; resolve(event); }
            else if (event.id && event.id === this.reply?.id) {
              if (event.type === 'error') { this.send({ type: 'error', error: '口型处理失败，请重新开始。' }); this.client?.close(); }
              else this.send({ ...event, id: undefined, replyId: this.reply.replyId });
            }
          } catch { worker.kill(); fail(); }
        }
      });
    });
    return this.preparing;
  }
  command(event) {
    if (!this.worker?.stdin || this.worker.stdin.writableLength > 6 * 1024 * 1024) throw new Error('本机口型处理积压。');
    this.worker.stdin.write(JSON.stringify(event) + '\n');
  }
  send(event) {
    if (this.client?.readyState !== WebSocket.OPEN) return;
    if (this.client.bufferedAmount > 4 * 1024 * 1024) { this.client.close(1013, '画面接收积压。'); return; }
    this.client.send(JSON.stringify(event));
  }
  attach(server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/avatar/live') return;
      const host = request.headers.host || ''; let hostname;
      try { hostname = new URL('http://' + host).hostname; } catch {}
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || request.headers.origin !== 'http://' + host) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      this.wss.handleUpgrade(request, socket, head, client => { this.connect(client).catch(() => client.close()); });
    });
  }
  async connect(client) {
    if (this.client) { client.close(1013, '已有口型对话，请先结束。'); return; }
    this.client = client; this.reply = null; let bytes = 0, finished = false;
    const cleanup = () => {
      if (this.client !== client) return;
      this.reply = null; this.client = null;
      try { this.command({ type: 'clear' }); } catch {}
    };
    client.on('close', cleanup); client.on('error', cleanup);
    try {
      const ready = await this.prepare(); if (this.client !== client || client.readyState !== WebSocket.OPEN) return;
      this.send(ready);
      client.on('message', (data, binary) => {
        if (this.client !== client) return;
        try {
          if (binary) {
            if (!this.reply || finished || !data.length || data.length % 2 || (bytes += data.length) > 24000 * 2 * 90) throw new Error();
            this.command({ type: 'audio', id: this.reply.id, pcm: data.toString('base64') }); return;
          }
          if (data.length > 4096) throw new Error();
          const event = JSON.parse(data.toString());
          if (event.type === 'warm') { if (!this.reply) this.command({ type: 'warm' }); }
          else if (event.type === 'clear') { this.reply = null; this.command({ type: 'clear' }); }
          else if (event.type === 'begin' && typeof event.replyId === 'string' && event.replyId.length > 0 && event.replyId.length <= 120) {
            bytes = 0; finished = false; this.reply = { id: randomUUID(), replyId: event.replyId };
            this.command({ type: 'begin', id: this.reply.id });
          } else if (event.type === 'finish' && this.reply && !finished) { finished = true; this.command({ type: 'finish', id: this.reply.id }); }
          else throw new Error();
        } catch { this.send({ type: 'error', error: '本机口型音频格式或缓冲异常，请重新开始。' }); client.close(); }
      });
    } catch { if (this.client === client) { this.send({ type: 'error', error: '本机口型模型加载失败，请重新开始。' }); client.close(); } }
  }
  close() { this.client?.close(); this.worker?.kill(); this.wss?.close(); }
}
