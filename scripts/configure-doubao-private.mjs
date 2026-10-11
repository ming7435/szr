// Configuration arrives through stdin, never command arguments or a plaintext file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoubaoService } from '../doubao-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = new DoubaoService(root);
try {
  process.stdin.setRawMode?.(true);
  console.log('等待私有配置输入。');
  const line = await new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error('配置输入超时。')); }, 45000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 12000) { clearTimeout(timer); process.stdin.destroy(); reject(new Error('配置输入过长。')); return; }
      const end = input.search(/[\r\n]/);
      if (end >= 0) { clearTimeout(timer); process.stdin.destroy(); resolve(input.slice(0, end)); input = ''; }
    });
    process.stdin.on('error', () => { clearTimeout(timer); reject(new Error('无法读取私有配置。')); });
  });
  const safe = await service.saveSettings(JSON.parse(line));
  console.log(JSON.stringify({ saved: true, selected: safe.selected, configured: safe.configured, voiceId: safe.voiceId }));
} catch {
  console.error('配置未保存，请检查本机加密服务与输入格式。'); process.exitCode = 1;
} finally { try { process.stdin.setRawMode?.(false); } catch {} service.close(); }
