// Opt-in live latency check with this app's own authorization and voice sample.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { pcmWave } from '../public/local-conversation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), base = 'http://127.0.0.1:4173';
const bytes = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(root, 'public/assets/voice-reference-clean.wav'), '-f', 'f32le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true });
const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
// Conversation turns begin after startup/welcome; exclude model loading here.
const prepared = await fetch(base + '/api/local-voice/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}', signal: AbortSignal.timeout(180000) });
if (!prepared.ok) throw new Error((await prepared.json()).error || 'Voice preparation failed.');
await prepared.arrayBuffer();
const started = performance.now();
const response = await fetch(base + '/api/local-voice/stream', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ audioBase64: pcmWave([samples], 16000), history: [], instructions: '你是友好自然的中文数字分身。' }), signal: AbortSignal.timeout(180000) });
if (!response.ok) throw new Error((await response.json()).error || 'Voice connection failed.');
const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', first, done;
const chunks = [];
await mkdir(path.join(root, 'output'), { recursive: true });
while (true) {
  const part = await reader.read(); if (part.done) break;
  buffer += decoder.decode(part.value, { stream: true }); let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
    const event = JSON.parse(line); if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'audio') {
      first ??= performance.now(); assert.equal(event.voice, 'uploaded-reference'); assert.equal(event.index, chunks.length);
      const wav = Buffer.from(event.audioBase64, 'base64'); assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.ok(event.duration > .1);
      chunks.push({ index: event.index, duration: event.duration, audioBytes: wav.length, arrivedSeconds: (performance.now() - started) / 1000 });
      await writeFile(path.join(root, `output/fast-voice-reply-${event.index}.wav`), wav);
    }
    if (event.type === 'done') done = event;
  }
}
assert.ok(done?.heard); assert.ok(chunks.length); assert.ok(done.replyText?.trim());
const report = { passed: true, checkedAt: new Date().toISOString(), startupExcluded: true, firstAudioSeconds: (first - started) / 1000, totalSeconds: (performance.now() - started) / 1000, model: done.model, voice: 'uploaded-reference', chunks, timings: done.timings, userText: done.userText, replyText: done.replyText };
await writeFile(path.join(root, 'output/voice-latency-optimized.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
