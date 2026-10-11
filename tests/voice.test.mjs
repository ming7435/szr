import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeService } from '../realtime-service.mjs';

function syntheticVoiceSample() {
  const rate=24000, samples=24000, wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVE',8);
  wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(4000*Math.sin(i*2*Math.PI*330/rate)),44+i*2);
  return wav;
}

test('concurrent voice submissions enroll once and persist only the successful voice ID', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const tempParent = path.join(workspace, 'output');
  await mkdir(tempParent, { recursive: true }); const root = await mkdtemp(path.join(tempParent, 'voice-test-'));
  await mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  const originalSample = syntheticVoiceSample();
  await writeFile(path.join(root, 'public', 'assets', 'voice-reference-clean.wav'), originalSample);
  let consents = 0, voices = 0, sampleCorrect = false;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://test.local', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }); const form = await request.formData();
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/voice_consents')) {
      consents++; assert.equal(form.get('language'), 'zh'); assert.equal(form.get('recording').type, 'audio/wav');
      await new Promise(resolve => setTimeout(resolve, 30)); res.end(JSON.stringify({ id: 'cons_local' }));
    } else {
      voices++; assert.equal(form.get('consent'), 'cons_local');
      sampleCorrect = Buffer.from(await form.get('audio_sample').arrayBuffer()).equals(originalSample); res.end(JSON.stringify({ id: 'voice_local_success' }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const service = new RealtimeService(root, { apiKey: 'local-test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, customVoiceId: 'voice_old_configured' });
    const input = { consentAudio: originalSample.toString('base64'), mimeType: 'audio/wav', language: 'zh' };
    const results = await Promise.allSettled([service.createVoice(input), service.createVoice(input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 429);
    assert.equal(consents, 1); assert.equal(voices, 1); assert.equal(sampleCorrect, true);
    assert.equal(await service.customVoiceId(), 'voice_local_success');
    const saved = await readFile(path.join(root, '.private', 'voice.json'), 'utf8'); assert.ok(!saved.includes('local-test'));
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(tempParent) + path.sep)); await rm(root, { recursive: true, force: true });
  }
});
