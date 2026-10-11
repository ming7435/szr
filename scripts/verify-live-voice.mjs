// Opt-in live check: requires this app's current ChatGPT authorization.
// Uses the supplied speaker sample; never prints account credentials.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { pcmWave } from '../public/local-conversation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:4173';
const session = await (await fetch(base + '/api/chatgpt/session')).json();
if (!session.sharing || session.status === 'connecting') {
  console.log(JSON.stringify({ passed: false, status: session.status, code: session.code || null }));
  process.exitCode = 1;
} else {
  const input = path.join(root, 'public/assets/voice-reference-clean.wav');
  const bytes = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-f', 'f32le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true });
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const started = Date.now();
  const response = await fetch(base + '/api/local-voice/turn', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ audioBase64: pcmWave([samples], 16000), history: [], instructions: '你是用户的中文数字分身。请用一句话回应对方。' }),
    signal: AbortSignal.timeout(180000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Live voice request failed.');
  assert.equal(result.heard, true); assert.equal(result.voice, 'uploaded-reference');
  assert.equal(result.mimeType, 'audio/wav'); assert.ok(result.userText?.trim()); assert.ok(result.replyText?.trim());
  const audio = Buffer.from(result.audioBase64, 'base64');
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF'); assert.equal(audio.subarray(8, 12).toString(), 'WAVE');
  assert.ok(audio.length > 1000); assert.ok(result.duration > .1);
  const report = { passed: true, checkedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - started) / 10) / 100, heard: true, voice: result.voice, duration: result.duration, audioBytes: audio.length, userText: result.userText, replyText: result.replyText };
  await mkdir(path.join(root, 'output'), { recursive: true });
  await writeFile(path.join(root, 'output/voice-dialogue-reply.wav'), audio);
  await writeFile(path.join(root, 'output/live-voice-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
