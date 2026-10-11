import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMResampler } from '../public/pcm-resampler.js';

const tone = (frequency, samples) => { const bytes = new Uint8Array(samples * 2), view = new DataView(bytes.buffer); for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / 24000)), true); return bytes; };
const transform = (bytes, chunk) => { const resampler = new PCMResampler(), output = []; for (let i = 0; i < bytes.length; i += chunk) output.push(resampler.push(bytes.subarray(i, i + chunk))); output.push(resampler.flush()); return Buffer.concat(output); };
const rms = bytes => { let sum = 0; const count = bytes.length / 2; for (let i = 100; i < count - 100; i++) sum += bytes.readInt16LE(i * 2) ** 2; return Math.sqrt(sum / (count - 200)); };

test('24→16 kHz preserves duration and gives identical results across arbitrary streaming boundaries', () => {
  const input = tone(1000, 60003), full = transform(input, input.length), streaming = transform(input, 514);
  assert.equal(full.length / 2, Math.floor(60003 * 2 / 3));
  assert.deepEqual(streaming, full);
  assert.ok(Math.abs(rms(full) / (12000 / Math.sqrt(2)) - 1) < .015);
  let crossings = 0; for (let i = 200; i < full.length / 2 - 200; i++) if (full.readInt16LE((i - 1) * 2) <= 0 && full.readInt16LE(i * 2) > 0) crossings++;
  assert.ok(Math.abs(crossings / ((full.length / 2 - 400) / 16000) - 1000) < 2);
});

test('high frequency input is filtered before downsampling; reset discards previous reply', () => {
  assert.ok(rms(transform(tone(10000, 24000), 1024)) < 200);
  const converter = new PCMResampler(); converter.push(tone(1000, 100)); converter.reset();
  assert.deepEqual(Buffer.concat([converter.push(tone(500, 1000)), converter.flush()]), transform(tone(500, 1000), 100));
  assert.throws(() => converter.push(new Uint8Array(3)));
});
