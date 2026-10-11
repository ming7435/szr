import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeService } from './realtime-service.mjs';
import { BusinessStore } from './business-service.mjs';
import { GuideStore } from './guide-service.mjs';
import { ChatGPTService, safeChatError } from './chatgpt-service.mjs';
import { LocalVoiceService, validateVoiceTurn } from './local-voice-service.mjs';
import { DoubaoService } from './doubao-service.mjs';
import { SimliService } from './simli-service.mjs';
import { LocalAvatarService } from './local-avatar-service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
for (const envFile of ['.env', '.env.local']) {
  try { process.loadEnvFile(path.join(ROOT, envFile)); } catch (e) { if (e.code !== 'ENOENT') console.error('本机环境配置文件无法读取。'); }
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request, limit = 20000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过长。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请发送有效的 JSON 文案。'); }
}

export function createServer(options = {}) {
  const business = new BusinessStore(options.dataRoot || ROOT);
  const guide = options.guide || new GuideStore(options.dataRoot || ROOT);
  const realtime = new RealtimeService(ROOT, options.config, business);
  const chatgpt = options.chatgpt || new ChatGPTService(options.dataRoot || ROOT);
  const localVoice = options.localVoice || new LocalVoiceService(ROOT);
  const doubao = options.doubao || new DoubaoService(options.dataRoot || ROOT, { guide });
  const simli = options.simli || new SimliService(options.dataRoot || ROOT);
  const localAvatar = options.localAvatar || new LocalAvatarService(ROOT);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const host = request.headers.host || '';
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return json(response, 403, { error: '仅支持本机访问。' }); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return json(response, 403, { error: '仅支持本机访问。' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return json(response, 403, { error: '仅接受本机页面请求。' });
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, { ...await realtime.publicConfig(), chatgpt: await chatgpt.publicSession(), localVoice: await localVoice.publicStatus(), doubao: await doubao.publicConfig(), simli: await simli.publicConfig(), localAvatar: localAvatar.publicConfig() });
      if (request.method === 'POST' && url.pathname === '/api/simli/settings') {
        try { return json(response, 200, await simli.saveSettings(await body(request, 12000))); }
        catch (error) { return json(response, error.status || 400, { error: error.status ? error.message : '视频配置保存失败，请检查输入格式与本机加密服务。' }); }
      }
      if ((request.method === 'GET' && url.pathname === '/api/simli/faces') || (request.method === 'POST' && url.pathname === '/api/simli/session')) {
        const controller = new AbortController();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          if (url.pathname.endsWith('/faces')) return json(response, 200, { faces: await simli.listFaces(controller.signal) });
          const voice = await doubao.publicConfig();
          if (!voice.selected || !voice.configured) return json(response, 409, { error: '请先接通豆包和你的复刻音色，再启用实时视频。' });
          return json(response, 200, await simli.session(controller.signal));
        } catch (error) { if (!response.destroyed) json(response, error.status || 502, { error: error.status ? error.message : '视频连接未完成，请检查本机设置。' }); }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/doubao/settings') {
        let input;
        try { input = await body(request, 12000); } catch { return json(response, 400, { error: '豆包配置格式不正确或过长。' }); }
        try { return json(response, 200, await doubao.saveSettings(input)); }
        catch (error) { return json(response, error.status || 500, { error: error.status ? error.message : '豆包配置保存失败，请检查本机加密服务。' }); }
      }
      if (request.method === 'POST' && ['/api/local-voice/start', '/api/local-voice/turn', '/api/local-voice/stream'].includes(url.pathname)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000); timeout.unref();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          if (!(await chatgpt.publicSession()).sharing) return json(response, 401, { error: '请先登录 ChatGPT 对话账号。' });
          if (url.pathname.endsWith('/start')) return json(response, 200, await localVoice.welcome(controller.signal));
          let input;
          try { input = await body(request, 1400000); }
          catch { return json(response, 400, { error: '语音请求格式不正确或录音过长。' }); }
          validateVoiceTurn(input);
          if (url.pathname.endsWith('/stream')) {
            response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
            response.flushHeaders();
            const send = event => { if (!response.destroyed && !controller.signal.aborted) response.write(JSON.stringify(event) + '\n'); };
            try { await localVoice.streamTurn(input, chatgpt, send, controller.signal); }
            catch (error) { send({ type: 'error', ...(error.code ? safeChatError(error) : { error: controller.signal.aborted ? '本次语音对话已停止。' : error.message }) }); }
            finally { response.end(); }
            return;
          }
          return json(response, 200, await localVoice.turn(input, chatgpt, controller.signal));
        } catch (error) {
          if (!response.destroyed) json(response, error.status || 502, error.code ? safeChatError(error) : { error: controller.signal.aborted ? '本次语音对话已停止。' : error.message });
        } finally { clearTimeout(timeout); }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/chatgpt/session') return json(response, 200, await chatgpt.publicSession());
      if (request.method === 'GET' && url.pathname === '/api/chatgpt/models') {
        try { return json(response, 200, { models: await chatgpt.models() }); }
        catch (error) { return json(response, error.status || 502, safeChatError(error)); }
      }
      if (request.method === 'POST' && ['/api/chatgpt/signin', '/api/chatgpt/cancel', '/api/chatgpt/signout'].includes(url.pathname)) {
        try {
          if (url.pathname === '/api/chatgpt/signin') return json(response, 200, await chatgpt.startSignIn(`http://127.0.0.1:${server.address().port}`));
          if (url.pathname === '/api/chatgpt/cancel') { chatgpt.cancelSignIn(); await chatgpt.waitForSignIn().catch(() => {}); }
          else await chatgpt.disconnect();
          return json(response, 200, await chatgpt.publicSession());
        } catch (error) { return json(response, error.status || 502, safeChatError(error)); }
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        let input;
        try { input = await body(request, 300000); chatgpt.validate(input); }
        catch (error) { return json(response, 400, { error: error.code === 'invalid_request' ? error.message : '消息格式或长度不符合要求。' }); }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000); timeout.unref();
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        const send = event => { if (!response.destroyed) response.write(JSON.stringify(event) + '\n'); };
        try { const result = await chatgpt.respond(input, delta => send({ type: 'delta', delta }), controller.signal); send({ type: 'done', ...result }); }
        catch (error) { send({ type: 'error', ...safeChatError(error) }); }
        finally { clearTimeout(timeout); response.end(); }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/business') return json(response, 200, await business.getProfile());
      if (request.method === 'GET' && url.pathname === '/api/guide') return json(response, 200, await guide.getState());
      if (request.method === 'POST' && url.pathname === '/api/guide') {
        let input;
        try { input=await body(request,35000); } catch { return json(response,400,{error:'讲解资料格式不正确或过长。'}); }
        return json(response,200,await guide.update(input));
      }
      if (request.method === 'GET' && url.pathname === '/api/leads') return json(response, 200, await business.listLeads());
      if (request.method === 'POST' && ['/api/business', '/api/leads'].includes(url.pathname)) {
        let input;
        try { input = await body(request, 60000); } catch (error) { return json(response, 400, { error: error.message }); }
        const result = url.pathname === '/api/business' ? await business.saveProfile(input) : await business.addLead(input);
        return json(response, url.pathname === '/api/leads' ? 201 : 200, result);
      }
      if (request.method === 'POST' && ['/api/session', '/api/voice/create'].includes(url.pathname)) {
        let input;
        try { input = await body(request, url.pathname === '/api/voice/create' ? 14010000 : 110000); }
        catch (e) { return json(response, 400, { error: e.message }); }
        const result = url.pathname === '/api/session' ? await realtime.session(input) : await realtime.createVoice(input);
        return json(response, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在。' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '不支持此请求方式。' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(response, 404, { error: '文件不存在。' }); }
      const filename = path.resolve(PUBLIC, '.' + (pathname === '/' ? '/index.html' : pathname));
      const relative = path.relative(PUBLIC, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return json(response, 404, { error: '文件不存在。' });
      try {
        const data = await readFile(filename);
        response.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch { json(response, 404, { error: '文件不存在。' }); }
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e.message);
      if (!response.headersSent) json(response, e.status || 500, { error: e.message || '服务暂时不可用，请重试。' });
    }
  });
  doubao.attach(server);
  localAvatar.attach(server);
  server.on('close', () => { chatgpt.cancelSignIn(); localVoice.close(); doubao.close(); simli.close(); localAvatar.close(); });
  server.localVoice = localVoice;
  server.doubao = doubao;
  server.simli = simli;
  server.localAvatar = localAvatar;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createServer();
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已在使用，请打开 http://127.0.0.1:${port} 或设置 PORT。` : e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`数字人已启动：http://127.0.0.1:${port}`);
    server.doubao.publicConfig().then(async config => { if (!config.selected) { const status = await server.localVoice.publicStatus(); if (status.available) await server.localVoice.welcome(); } }).catch(() => console.error('本机声音服务未能预热，页面连接时可重试。'));
  });
}
