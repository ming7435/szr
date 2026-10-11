import { AvatarRenderer } from './avatar.js';
import { ProConversation } from './pro-chat.js';
import { RealtimeConversation } from './realtime.js';
import { LocalConversation } from './local-conversation.js';
import { DoubaoConversation } from './doubao-conversation.js';
import { SimliVideo } from './simli-video.js';
import { LocalMouth } from './local-mouth.js';
import { FaceExpression } from './face-expression.js';
import { FaceMotion } from './face-motion.js';
import { HandMotion } from './hand-motion.js';
import { GuidePanel } from './guide-panel.js';
import { guidePreferences } from './guide-persona.js';

const $ = id => document.getElementById(id);
const voiceOnly = document.body.dataset.conversationMode === 'voice-only';
const avatar = new AvatarRenderer(document.querySelector('.avatar-panel'));
const expressions = new FaceExpression({ canvas: $('face-expression-canvas'), image: $('portrait') });
const facialMotion = new FaceMotion({ element: $('portrait-layers'), stage: $('portrait-stage'), image: $('portrait'), source: $('local-mouth-canvas'), onActivity: level => expressions.setSpeech(level) });
const handMotion = new HandMotion({ stage: $('portrait-stage'), image: $('portrait'), source: $('local-mouth-canvas') });
expressions.load();
facialMotion.load();
handMotion.load();
window.addEventListener('pagehide', event => {
  if (event.persisted) { expressions.setSuspended(true); facialMotion.setSuspended(true); handMotion.setSuspended(true); }
  else { expressions.dispose(); facialMotion.dispose(); handMotion.dispose(); }
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { expressions.setSuspended(false); facialMotion.setSuspended(false); handMotion.setSuspended(false); }
});
const state = { connected: false, connecting: false, messages: [], config: null, generation: 0, voiceBlob: null, recorder: null };
const guide = new GuidePanel({ beforeSwitch: () => {
  if(state.connected||state.connecting){state.generation++;state.connecting=false;activeConversation?.disconnect();}
}, onChange: () => updateConnection(), onError: message => toast(message) });
let toastTimer;
function interfaceMessage(message) { return String(message ?? '').replace(/豆包|火山(?:引擎)?|doubao|volcengine/gi, '语音服务'); }
function toast(message) { $('toast').textContent = interfaceMessage(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
function status(text, subtitle = null) {
  $('avatar-status').textContent = interfaceMessage(text);
  if (subtitle !== null) $('subtitle').textContent = subtitle;
  $('avatar-dot').classList.toggle('speaking', text === '我正在回应' || text === '正在试听数字人音色');
  const phase = text === '我正在回应' ? 'responding' : text === '我正在听' ? 'listening' : text === '正在回应' || /思考|想一想|组织回答/.test(text) ? 'thinking' : 'idle';
  expressions.setState(phase); facialMotion.setState(phase); handMotion.setState(phase);
}
function openSettings() { if (!$('settings').open) $('settings').showModal(); }
function updateDoubaoAuth() {
  const apiKey = $('doubao-auth-mode').value === 'api-key';
  $('doubao-api-key-fields').hidden = !apiKey; $('doubao-app-fields').hidden = apiKey;
  $('doubao-api-key').required = apiKey; $('doubao-app-id').required = !apiKey; $('doubao-token').required = !apiKey;
}
$('doubao-auth-mode').addEventListener('change', updateDoubaoAuth);
function saveSettings() { $('persona').value = guidePreferences($('persona').value); localStorage.setItem('avatar-settings', JSON.stringify({ persona: $('persona').value, eagerness: $('vad-eagerness').value })); }
try { const saved = JSON.parse(localStorage.getItem('avatar-settings') || '{}'); if (saved.persona) $('persona').value = saved.persona; if (saved.eagerness) $('vad-eagerness').value = saved.eagerness; } catch {}
saveSettings();
$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('close', () => { state.recordingGeneration = (state.recordingGeneration || 0) + 1; if (state.recorder?.state === 'recording') state.recorder.stop(); });
$('settings').addEventListener('click', e => { if (e.target === $('settings') && (e.offsetX < 0 || e.offsetY < 0 || e.offsetX > $('settings').offsetWidth || e.offsetY > $('settings').offsetHeight)) $('settings').close(); });
$('settings-save').addEventListener('click', async () => {
  if(guide.dirty && !await guide.save())return;
  saveSettings(); $('settings').close(); toast('设置已保存，下次连接时生效。');
});
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.avatar-panel').requestFullscreen(); } catch { toast('当前浏览器无法进入全屏。'); } });
$('motion-toggle').addEventListener('click', () => { avatar.enabled = !avatar.enabled; expressions.setEnabled(avatar.enabled); facialMotion.setEnabled(avatar.enabled); handMotion.setEnabled(avatar.enabled); $('motion-toggle').textContent = avatar.enabled ? '动效开启' : '动效关闭'; $('motion-toggle').setAttribute('aria-pressed', String(avatar.enabled)); });
$('motion-toggle').textContent = avatar.enabled ? '动效开启' : '动效关闭';
$('motion-toggle').setAttribute('aria-pressed', String(avatar.enabled));
$('portrait').addEventListener('error', () => toast('人物图片未能加载，请检查项目素材文件。'));

const reference = $('reference-audio');

function renderMessages() {
  $('empty-chat').hidden = state.messages.length > 0;
  $('chat').querySelectorAll('.chat-message').forEach(node => node.remove());
  for (const message of state.messages) {
    const row = document.createElement('div'); row.className = `chat-message ${message.role} ${message.pending ? 'pending' : ''} ${message.interrupted ? 'interrupted' : ''}`;
    const role = document.createElement('div'); role.className = 'message-role'; role.textContent = message.role === 'user' ? '你' : guide.current?.role || '数字讲解员';
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message.text || '正在聆听…'; row.append(role, text);
    if (message.interrupted || message.error) { const meta = document.createElement('div'); meta.className = 'message-meta'; meta.textContent = message.interrupted ? '已打断' : '回答未完成 · ' + message.error; row.append(meta); }
    $('chat').append(row);
  }
  $('chat').scrollTop = $('chat').scrollHeight;
}
function addMessage(role, text, id = crypto.randomUUID(), pending = false) {
  let message = state.messages.find(m => m.id === id);
  if (!message) { message = { id, role, text: '', pending }; state.messages.push(message); }
  message.text = text; message.pending = pending; renderMessages(); return message;
}
$('clear-chat').addEventListener('click', () => { pro.abort(); state.messages = []; renderMessages(); toast('页面记录已清空。'); });
function download(blob, filename) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('export-chat').addEventListener('click', () => { if (!state.messages.length) return toast('还没有可导出的对话。'); const role = guide.current?.role || '数字讲解员'; download(new Blob([state.messages.map(m => `${m.role === 'user' ? '你' : role}：${m.text}${m.interrupted ? '（已打断）' : ''}`).join('\n\n')], { type: 'text/plain;charset=utf-8' }), `${role}对话.txt`); });

// The realtime transport is installed by the backend integration module.
let realtime;
let activeConversation;
const localConversation = new LocalConversation({ audio: $('remote-audio'), onStatus: status, onMessage: addMessage, onError: toast, onConnection: connected => { state.connected = connected; updateConnection(); }, onAudio: () => avatar.attach($('remote-audio')) });
const doubaoConversation = new DoubaoConversation({ audio: $('remote-audio'), onStatus: status, onError: message => { toast(message); if (message.includes('开启声音')) $('audio-resume').hidden = false; }, onConnection: connected => { state.connected = connected; updateConnection(); }, onAudio: stream => avatar.attach($('remote-audio'), stream) });
const liveVideo = new SimliVideo({ video: $('live-avatar-video'), stage: $('portrait-stage'), onStatus: status, onAudio: stream => avatar.attach($('live-avatar-video'), stream), onMode: enabled => { state.videoActive = enabled; $('avatar-mode').textContent = enabled ? '实时口型 · 自然表情' : '照片驱动 · 语音动效'; updateConnection(); }, onPlayback: speaking => { if (speaking) status('我正在回应'); else if (!doubaoConversation.generating) status('我正在听'); }, onError: message => { toast(message); if (message.includes('开启声音')) $('audio-resume').hidden = false; else doubaoConversation.disconnect(); } });
doubaoConversation.renderer = liveVideo;
const localMouth = new LocalMouth({ canvas: $('local-mouth-canvas'), image: $('portrait'), audio: $('remote-audio'), stage: $('portrait-stage'), onStatus: status, onAudio: stream => avatar.attach($('remote-audio'), stream), onMode: enabled => { state.videoActive = enabled; $('avatar-mode').textContent = enabled ? '实时口型' : '照片驱动 · 语音动效'; updateConnection(); }, onPlayback: speaking => status(speaking ? '我正在回应' : '我正在听'), onError: message => { toast(message); doubaoConversation.disconnect(); } });
liveVideo.onReconnecting = value => { state.videoReconnecting = value; updateConnection(); };
try {
  realtime = new RealtimeConversation({ audio: $('remote-audio'), onStatus: status, onMessage: addMessage, onError: toast, onConnection: connected => { state.connected = connected; updateConnection(); }, onAudio: async stream => { reference.pause(); await avatar.attach($('remote-audio'), stream); }, onInterruption: id => { const message = state.messages.find(m => m.id === id); if (message) { message.interrupted = true; message.pending = false; renderMessages(); } } });
} catch { toast('实时对话模块加载失败，请刷新页面。'); }

const pro = new ProConversation({
  onState: (session, models) => {
    const wasSharing = !!state.pro?.sharing;
    state.pro = session;
    if (state.config) state.config.chatgpt = session;
    if (!wasSharing && session.sharing && $('settings').open) $('settings').close();
    $('chatgpt-status').textContent = session.status === 'connecting' ? '请在官方页面完成登录授权' : session.error || (session.sharing ? '对话账号已连接' + (session.identity?.name ? ' · ' + session.identity.name : '') : session.status === 'connected' ? '已登录 · 尚未授权套餐使用' : '登录后开始语音对话');
    $('chatgpt-signin').hidden = session.sharing; $('chatgpt-signin').disabled = session.status === 'connecting';
    $('chatgpt-signin').textContent = session.status === 'connected' ? '重新登录并授权套餐' : '使用 ChatGPT 登录';
    $('chatgpt-cancel').hidden = session.status !== 'connecting';
    $('chatgpt-options').hidden = !session.sharing;
    const selected = $('chatgpt-model').value;
    $('chatgpt-model').replaceChildren(...models.map(model => { const option = document.createElement('option'); option.value = model.slug; option.textContent = model.displayName; return option; }));
    if (models.some(model => model.slug === selected)) $('chatgpt-model').value = selected;
    $('chatgpt-model').disabled = !models.length;
    updateConnection();
  }, onMessage: addMessage, onStatus: status, onError: toast,
  onFailure: (id, error, cancelled) => { const message = state.messages.find(item => item.id === id); if (message) { message.pending = false; message.error = cancelled ? null : error; message.interrupted = cancelled; if (!message.text) message.text = cancelled ? '回答已停止。' : '本次回答未完成。'; renderMessages(); } },
  onBusy: busy => { state.textBusy = busy; $('send').disabled = busy; $('pro-stop').hidden = !busy; },
  onAuthorization: url => { $('chatgpt-login-link').hidden = !url; if (url) $('chatgpt-login-link').href = url; else $('chatgpt-login-link').removeAttribute('href'); },
});
$('chatgpt-signin').addEventListener('click', () => pro.signIn());
$('chatgpt-cancel').addEventListener('click', () => pro.cancelSignIn().catch(error => toast(error.message)));
$('chatgpt-signout').addEventListener('click', () => pro.disconnect().catch(error => toast(error.message)));
$('pro-stop').addEventListener('click', () => pro.abort());

function updateConnection() {
  $('connect').querySelector('span').textContent = state.connected ? '结束对话' : state.connecting ? '取消连接' : '开始对话 · 语音';
  $('connect').classList.toggle('disconnect', state.connected);
  $('connect').disabled = guide.loading || guide.saving || !guide.ready;
  $('mute').disabled = !state.connected; $('interrupt').disabled = !state.connected;
  if (!state.connected) { $('mute').setAttribute('aria-pressed', 'false'); $('mute').setAttribute('aria-label', '关闭麦克风'); $('audio-resume').hidden = true; }
  if (state.config?.doubao?.selected) {
    $('connection-summary').textContent = state.connected ? state.videoReconnecting ? '实时人像重新连接中' : state.videoActive ? '声画对话已连接' : '语音对话已连接' : state.connecting ? state.config.simli?.enabled ? '正在连接实时数字人' : '正在连接语音服务' : state.config.doubao.configured ? '可以开始验证' : '语音服务待配置';
    $('connection-dot').classList.toggle('ready', !!state.config.doubao.configured);
    $('connection-dot').classList.toggle('connected', state.connected);
    $('control-note').textContent = state.connected ? '我正在听。想了解什么，直接问我，随时可以插话。' : state.config.doubao.configured ? '点击开始，用声音问我景点、游览路线或游客服务。' : '先在「景区与分身设置」中接入专属音色。';
    return;
  }
  const ready = !!(state.config?.localVoice?.available && state.config?.chatgpt?.sharing) || !!(state.config?.apiConfigured && state.config?.customVoiceId);
  $('connection-summary').textContent = state.connected ? '语音对话已连接' : !voiceOnly && state.pro?.sharing ? state.pro.verified ? '文字对话已连通' : 'ChatGPT 已登录' : ready ? '可以开始对话' : state.config?.localVoice?.available ? '请登录对话账号' : state.config?.apiConfigured ? '数字人音色待接入' : 'AI 服务待配置';
  $('connection-dot').classList.toggle('ready', ready || !!state.pro?.sharing);
  $('connection-dot').classList.toggle('connected', state.connected || !!state.pro?.verified);
  $('control-note').textContent = state.connected ? '我正在听。自然说话，随时可以插话。' : voiceOnly ? '语音接通后直接说话，随时可以插话打断。' : state.pro?.sharing ? '下方输入文字即可聊天。实时语音需单独接入。' : '文字对话请先登录 ChatGPT；语音对话需接入专属音色。';
}
$('connect').addEventListener('click', async () => {
  if (state.connecting) { state.generation++; state.connecting = false; activeConversation?.disconnect(); updateConnection(); return; }
  if (state.connected) { activeConversation?.disconnect(); return; }
  if (state.config?.doubao?.selected) {
    if (!state.config.doubao.configured) { openSettings(); ($('doubao-auth-mode').value === 'api-key' ? $('doubao-api-key') : $('doubao-app-id')).focus(); return; }
    activeConversation = doubaoConversation;
  }
  else if (state.config?.localVoice?.available && !state.config?.chatgpt?.sharing) { openSettings(); $('chatgpt-signin').focus(); await pro.signIn(); return; }
  else if (state.config?.localVoice?.available && state.config?.chatgpt?.sharing) activeConversation = localConversation;
  else {
    if (!state.config?.apiConfigured) { openSettings(); toast('语音服务尚未就绪，请检查对话账号连接。'); return; }
    if (!state.config?.customVoiceId) { openSettings(); toast('请先完成数字人的专属音色接入。'); return; }
    if (!realtime) return toast('实时对话模块尚未就绪。');
    activeConversation = realtime;
  }
  reference.pause(); saveSettings(); const generation = ++state.generation; state.connecting = true; updateConnection();
  const localMouthEnabled = !state.config?.simli?.enabled && state.config?.localAvatar?.enabled === true;
  doubaoConversation.renderer = localMouthEnabled ? localMouth : liveVideo;
  try { await activeConversation.connect({ instructions: $('persona').value, guideScene: guide.selectedScene, eagerness: $('vad-eagerness').value, video: state.config?.simli?.enabled === true || localMouthEnabled }); }
  catch (e) { if (generation === state.generation) toast(e.message); }
  finally { if (generation === state.generation) { state.connecting = false; updateConnection(); } }
});
$('mute').addEventListener('click', () => { const muted = activeConversation?.toggleMute(); $('mute').setAttribute('aria-pressed', String(muted)); $('mute').setAttribute('aria-label', muted ? '打开麦克风' : '关闭麦克风'); toast(muted ? '麦克风已关闭。' : '麦克风已打开。'); });
$('interrupt').addEventListener('click', () => activeConversation?.interrupt());
$('audio-resume').addEventListener('click', async () => { try { if (state.videoActive) await doubaoConversation.renderer.resume(); else await $('remote-audio').play(); $('audio-resume').hidden = true; } catch { toast('声音仍无法播放，请检查浏览器的音频权限。'); } });
$('text-form').addEventListener('submit', e => {
  e.preventDefault(); const text = $('message').value.trim(); if (!text || state.textBusy) return;
  if (state.connected) { try { activeConversation?.sendText?.(text); $('message').value = ''; } catch (error) { toast(error.message); } return; }
  if (!pro.session.sharing || !pro.models.length) { toast('请先使用 ChatGPT 登录，载入可用模型后发送消息。'); $('chatgpt-signin').focus(); return; }
  const history = state.messages.filter(message => !message.pending && !message.error && !message.interrupted && message.text).map(message => ({ role: message.role, text: message.text }));
  let kept = history.slice(-39); while (kept.reduce((sum, message) => sum + message.text.length, text.length) > 60000 || kept.some(message => message.text.length > 12000)) kept.shift();
  reference.pause(); $('message').value = ''; pro.send(text, kept, $('persona').value, $('chatgpt-model').value);
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('message').value = button.dataset.prompt; $('message').focus(); if (state.connected || pro.session.sharing) $('text-form').requestSubmit(); }));

async function loadConfig() {
  try { const response = await fetch('/api/config'); if (!response.ok) throw new Error(); state.config = await response.json(); }
  catch { state.config = { apiConfigured: false, customVoiceId: null }; }
  $('simli-settings').hidden = !state.config.doubao?.selected;
  $('local-mouth-status').hidden = !state.config.localAvatar?.enabled || state.config.simli?.enabled === true;
  const videoConfig = state.config.simli || {};
  $('simli-face-id').value = videoConfig.faceId || '';
  $('simli-own-portrait').checked = videoConfig.configured === true;
  $('simli-enabled').checked = videoConfig.enabled === true;
  $('simli-status').textContent = videoConfig.error || (videoConfig.configured ? videoConfig.enabled ? '实时人像已配置，开始对话时验证实际声画。' : '人像模型已配置，目前使用照片语音模式。' : videoConfig.credentialConfigured ? '密钥已加密保存，等待当前照片的人像模型 Face ID。' : '先保存密钥，再准备当前照片的人像模型。');
  $('doubao-settings').hidden = !state.config.doubao?.selected;
  if (state.config.doubao?.selected) {
    $('setup-notice').textContent = interfaceMessage(state.config.doubao.error || (state.config.doubao.configured ? '配置已保存在本机，点击「开始对话」连接。麦克风音频和角色设置将发送给云端语音服务。' : '先开通实时语音和声音复刻服务，用下方降噪录音训练音色，再填写应用凭据和 S_ 音色 ID。'));
    document.querySelector('.voice-enrollment').hidden = true;
    document.querySelector('.chatgpt-card').hidden = true;
    $('doubao-app-id').value = state.config.doubao.appId || '';
    $('doubao-voice-id').value = state.config.doubao.voiceId || '';
    $('doubao-auth-mode').value = state.config.doubao.authMode || 'api-key'; updateDoubaoAuth();
    $('vad-eagerness').closest('.settings-row').hidden = true;
    updateConnection(); return;
  }
  $('setup-notice').textContent = state.config.localVoice?.available ? state.config.chatgpt?.sharing ? '对话使用你上传录音提取的音色。说完停顿后，我会回答。语音在本机处理，问题文字发送给 ChatGPT。' : '你的声音已准备完成，请登录对话账号后开始聊天。' : !state.config.apiConfigured ? '实时语音尚未连接：本机未配置 OpenAI API Key。' : !state.config.customVoiceId ? 'AI 服务已配置，请完成下方的专属音色接入。' : '数字人固定使用你的专属音色。连接时，麦克风声音和对话内容会发送给 OpenAI。';
  document.querySelector('.voice-enrollment').hidden = !!state.config.localVoice?.available;
  updateConnection();
}
// Record the exact consent phrase; user starts and submits the recording explicitly.
let consentStream, consentUrl;
function setConsent(blob) { state.voiceBlob = blob; if (consentUrl) URL.revokeObjectURL(consentUrl); consentUrl = URL.createObjectURL(blob); $('consent-preview').src = consentUrl; $('consent-preview').hidden = false; $('create-voice').disabled = false; $('enrollment-status').textContent = '授权录音已就绪。请先试听，确认只有指定语句且说话人与参考录音一致。'; }
$('record-consent').addEventListener('click', async () => {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (state.recordingPending) return;
  if (state.connected || state.connecting) return toast('请先结束实时对话，再录制授权语句。');
  state.recordingPending = true; $('record-consent').disabled = true;
  const generation = state.recordingGeneration || 0;
  let acquiredStream;
  try {
    reference.pause();
    acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (generation !== (state.recordingGeneration || 0) || !$('settings').open) { acquiredStream.getTracks().forEach(track => track.stop()); return; }
    const stream = acquiredStream; consentStream = stream;
    const chunks = []; const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined); state.recorder = recorder;
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); setConsent(new Blob(chunks, { type: recorder.mimeType.split(';')[0] })); $('record-consent').textContent = '● 重新录制'; clearTimeout(state.recordingTimer); };
    recorder.start(); $('record-consent').textContent = '■ 停止录制'; $('enrollment-status').textContent = '正在录音，请朗读指定的授权语句…'; state.recordingTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 30000);
  } catch (e) { acquiredStream?.getTracks().forEach(track => track.stop()); if (generation === (state.recordingGeneration || 0)) toast(e.name === 'NotAllowedError' ? '请允许使用麦克风后再录音。' : '无法启动录音，请在 Chrome 或 Edge 中打开本机网页。'); }
  finally { state.recordingPending = false; $('record-consent').disabled = false; }
});
$('consent-file').addEventListener('change', () => { const file = $('consent-file').files[0]; if (file) { if (file.size > 10 * 1024 * 1024) return toast('授权录音不能超过 10 MB。'); setConsent(file); } });
$('create-voice').addEventListener('click', async () => {
  if (!state.config.apiConfigured) return toast('先在本机配置 API Key，再创建音色。');
  if (!state.voiceBlob) return toast('请先录制或选择授权录音。');
  const button = $('create-voice'); button.disabled = true; button.textContent = '正在创建专属音色…';
  try {
    const bytes = new Uint8Array(await state.voiceBlob.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const response = await fetch('/api/voice/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consentAudio: btoa(binary), mimeType: state.voiceBlob.type.split(';')[0], language: 'zh' }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    await loadConfig(); saveSettings(); $('enrollment-status').textContent = '专属音色已绑定数字人，每次回答都会使用你的声音。'; toast('数字人音色已就绪。');
  } catch (e) { $('enrollment-status').textContent = e.message; toast(e.message); }
  finally { button.disabled = false; button.textContent = '创建并使用专属音色'; }
});
$('doubao-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.connected || state.connecting) return toast('请先结束对话，再保存配置。');
  const button = $('doubao-save'); button.disabled = true;
  try {
    const authMode = $('doubao-auth-mode').value;
    const credentials = authMode === 'api-key' ? { apiKey: $('doubao-api-key').value.trim() } : { appId: $('doubao-app-id').value.trim(), accessToken: $('doubao-token').value.trim() };
    const response = await fetch('/api/doubao/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authMode, ...credentials, voiceId: $('doubao-voice-id').value.trim(), ownVoiceConfirmed: $('doubao-own-voice').checked }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '配置保存失败。');
    $('doubao-token').value = ''; $('doubao-api-key').value = ''; await loadConfig(); toast('配置已加密保存。关闭设置后点击「开始对话」验证。');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('simli-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.connected || state.connecting) return toast('请先结束对话，再修改实时人像设置。');
  const button = $('simli-save'); button.disabled = true;
  try {
    const response = await fetch('/api/simli/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: $('simli-api-key').value.trim(), faceId: $('simli-face-id').value.trim(), enabled: $('simli-enabled').checked, ownPortraitConfirmed: $('simli-own-portrait').checked }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '实时人像设置保存失败。');
    $('simli-api-key').value = ''; await loadConfig(); toast('实时人像设置已加密保存，下次对话生效。');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('simli-refresh').addEventListener('click', async () => {
  const button = $('simli-refresh'); button.disabled = true;
  try {
    const response = await fetch('/api/simli/faces'); const result = await response.json(); if (!response.ok) throw new Error(result.error);
    $('simli-status').textContent = result.faces.length ? '账号内已有人像模型。请从 Your Avatars 复制当前照片对应的 Face ID。' : '账号连接成功，尚无人像模型。请用当前照片准备可实时驱动的人像。';
  } catch (error) { $('simli-status').textContent = error.message; } finally { button.disabled = false; }
});
window.addEventListener('beforeunload', () => { pro.dispose(); realtime?.disconnect(); localConversation.disconnect(false); doubaoConversation.disconnect(false); consentStream?.getTracks().forEach(track => track.stop()); });
await Promise.all([loadConfig(), guide.load()]);
if (!state.config.doubao?.selected && state.config.localVoice?.available) {
  const card = document.querySelector('.chatgpt-card');
  $('settings').insertBefore(card, document.querySelector('.settings-section'));
  card.hidden = false;
  $('chatgpt-model').hidden = voiceOnly;
  await pro.load();
} else if (!state.config.doubao?.selected && !voiceOnly) await pro.load();
