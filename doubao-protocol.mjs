import { gunzipSync } from 'node:zlib';

const MAX_BYTES = 2 * 1024 * 1024;
const invalid = () => new Error('实时语音协议格式异常。');
const integer = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
export function encodeFrame(event, payload, sessionId = '', type = Buffer.isBuffer(payload) ? 2 : 1) {
  const raw = Buffer.isBuffer(payload), body = raw ? payload : Buffer.from(JSON.stringify(payload));
  if (body.length > MAX_BYTES) throw invalid();
  const id = Buffer.from(sessionId);
  const fields = [Buffer.from([0x11, (type << 4) | 4, raw ? 0 : 0x10, 0]), integer(event)];
  if (event >= 100 || (event >= 50 && event < 100)) fields.push(integer(id.length), id);
  return Buffer.concat([...fields, integer(body.length), body]);
}
export function decodeFrame(input) {
  const buffer = Buffer.from(input); if (buffer.length < 12 || buffer.length > MAX_BYTES || buffer[0] !== 0x11) throw invalid();
  const type = buffer[1] >> 4, flags = buffer[1] & 15, serialization = buffer[2] >> 4, compression = buffer[2] & 15;
  if (![1, 2, 9, 11, 15].includes(type) || ![0, 1].includes(serialization) || ![0, 1].includes(compression)) throw invalid();
  let offset = 4, code, event = 0, sessionId = '';
  const number = () => { if (offset + 4 > buffer.length) throw invalid(); const value = buffer.readUInt32BE(offset); offset += 4; return value; };
  const bytes = size => { if (size > MAX_BYTES || offset + size > buffer.length) throw invalid(); const value = buffer.subarray(offset, offset + size); offset += size; return value; };
  if (type === 15) code = number();
  if (flags & 1) number();
  if (flags & 4) event = number();
  if (event >= 50 && event < 100) bytes(number());
  else if (event >= 100) { const length = number(); if (length > 256) throw invalid(); sessionId = bytes(length).toString('utf8'); }
  let payload = bytes(number()); if (offset !== buffer.length) throw invalid();
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: MAX_BYTES });
  if (serialization === 1) payload = JSON.parse(payload.toString('utf8'));
  return { type, event, sessionId, code, payload };
}
