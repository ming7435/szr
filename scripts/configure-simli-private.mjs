// Private input is read without terminal echo and stored with Windows DPAPI.
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWindowsEncryption } from '../windows-encryption.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.private/simli');
try {
  process.stdin.setRawMode?.(true);
  console.log('等待私有配置输入。');
  const line = await new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error()); }, 45000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 12000) { clearTimeout(timer); process.stdin.destroy(); reject(new Error()); return; }
      const end = input.search(/[\r\n]/);
      if (end >= 0) { clearTimeout(timer); process.stdin.destroy(); resolve(input.slice(0, end)); input = ''; }
    });
    process.stdin.on('error', () => { clearTimeout(timer); reject(new Error()); });
  });
  const input = JSON.parse(line);
  if (typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{10,4096}$/.test(input.apiKey)) throw new Error();
  const encryption = createWindowsEncryption();
  const ciphertext = await encryption.encrypt(JSON.stringify({ apiKey: input.apiKey, faceId: null, enabled: false, ownPortraitConfirmed: false }));
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'settings.json'), temporary = filename + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify({ version: 1, provider: encryption.id, ciphertext: Buffer.from(ciphertext).toString('base64') }), { flag: 'wx', flush: true }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
  console.log(JSON.stringify({ saved: true, encrypted: true }));
  try {
    const response = await fetch('https://api.simli.ai/faces', { headers: { 'x-simli-api-key': input.apiKey }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => null);
    console.log(JSON.stringify({ connectionChecked: true, status: response.status, authenticated: response.ok && Array.isArray(data), faces: Array.isArray(data) ? data.map(face => ({ id: face.id, version: face.simli_version })) : [] }));
  } catch { console.log(JSON.stringify({ connectionChecked: false, reason: '网络或服务暂时不可用。' })); }
} catch { console.error('配置未保存，请检查输入格式和本机加密服务。'); process.exitCode = 1; }
finally { try { process.stdin.setRawMode?.(false); } catch {} }
