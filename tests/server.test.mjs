import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server.mjs';

let server, base;
before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('system voice listing and synthesis are unavailable', async () => {
  assert.equal((await fetch(`${base}/api/voices`)).status, 404);
  const response = await fetch(`${base}/api/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
  assert.equal(response.status, 404);
});

test('only public files are served', async () => {
  for (const pathname of ['/server.mjs', '/speech.ps1', '/%2e%2e%2fserver.mjs']) {
    assert.equal((await fetch(base + pathname)).status, 404);
  }
});

test('optional local reference audio is served when present without constraining response length', async () => {
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.referenceAudio, '/assets/voice-reference-clean.m4a');
  assert.equal(Object.hasOwn(config, 'referenceDuration'), false);
  let reference;
  try { reference=await readFile(new URL('../public/assets/voice-reference-clean.wav',import.meta.url)); }
  catch(error){ if(error.code!=='ENOENT')throw error; }
  const result = await fetch(`${base}/assets/voice-reference-clean.wav`);
  if(!reference){assert.equal(result.status,404);return;}
  assert.equal(result.status, 200);
  const wav = Buffer.from(await result.arrayBuffer());
  assert.deepEqual(wav,reference);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.ok(wav.length > 10000);
});
