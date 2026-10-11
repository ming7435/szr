import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./windows-credential.ps1', import.meta.url));
function transform(operation, bytes) {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前接入需要 Windows 本机加密服务。'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, operation], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows 本机加密服务响应超时。')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > 1500000) { child.kill(); finish(new Error('登录资料过大。')); } });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Windows 本机加密服务无法启动。')));
    child.stdin.on('error', () => finish(new Error('Windows 本机加密服务无法读取登录资料。')));
    child.on('close', code => { if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) finish(new Error('登录资料无法加密或解密，原文件已保留。')); else finish(null, Buffer.from(output, 'base64')); });
    // Secrets travel only through private process pipes, never command arguments or logs.
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}
export function createWindowsEncryption() {
  return { id: 'windows-dpapi-current-user-v1', encrypt: text => transform('encrypt', Buffer.from(text, 'utf8')), decrypt: async bytes => (await transform('decrypt', bytes)).toString('utf8') };
}
