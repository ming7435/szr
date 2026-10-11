// Run only after the user asks to remove the unused avatar membership connection.
// Credentials remain inside the normal encrypted service and are never printed.
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatGPTService } from '../chatgpt-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:4173';
const config = await (await fetch(base + '/api/config')).json();
assert.equal(config.doubao?.selected, true, 'The avatar must use Doubao before removing its previous membership connection');
assert.equal(config.doubao?.configured, true, 'The current voice service must be configured');
const result = await new ChatGPTService(root).removeConnection();
const current = await (await fetch(base + '/api/config')).json();
assert.equal(current.chatgpt.status, 'disconnected');
assert.equal(current.chatgpt.sharing, false); assert.equal(current.chatgpt.identity, null);
assert.equal(current.doubao.selected, true); assert.equal(current.doubao.configured, true);
assert.equal(current.doubao.voiceId, config.doubao.voiceId);
const files = await readdir(path.join(root, '.private', 'chatgpt'));
assert.equal(files.length, 0, 'Saved ChatGPT login files remain');
const report = { ...result, checkedAt: new Date().toISOString(), localLoginFiles: files.length, chatgptConnected: false, currentProvider: 'doubao', clonedVoicePreserved: true, inferenceCalls: 0 };
await writeFile(path.join(root, 'output', 'chatgpt-removal-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
