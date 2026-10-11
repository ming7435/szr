import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { BusinessStore } from '../business-service.mjs';
import { RealtimeService } from '../realtime-service.mjs';
import { createServer } from '../server.mjs';

const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'output');
const profile = { company: '本地接待测试企业', products: '提供设备维护服务，标准上门服务费为 200 元。', faq: '服务时间为周一到周五 9:00–18:00。', humanContact: '请在网页留下联系方式。' };
async function temporary(action) {
  const root = await mkdtemp(path.join(parent, 'business-test-'));
  try { await action(root); }
  finally { assert.ok(root.startsWith(parent + path.sep)); await rm(root, { recursive: true, force: true }); }
}

test('business knowledge persists locally and validates field limits', async () => temporary(async root => {
  const store = new BusinessStore(root);
  assert.equal((await store.getProfile()).company, '');
  await store.saveProfile(profile);
  assert.deepEqual(await new BusinessStore(root).getProfile(), profile);
  await assert.rejects(store.saveProfile({ ...profile, products: '字'.repeat(6001) }), { status: 400 });
  await assert.rejects(store.saveProfile({ ...profile, company: '' }), { status: 400 });
}));

test('leads need affirmative submission and concurrent records stay intact', async () => temporary(async root => {
  const store = new BusinessStore(root); await store.saveProfile(profile);
  await assert.rejects(store.addLead({ contact: 'test@example.invalid', agreed: false }), { status: 400 });
  await assert.rejects(store.addLead({ contact: '', agreed: true }), { status: 400 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.addLead({ name: `测试访客${i}`, contact: `visitor${i}@example.invalid`, interest: '设备维护咨询', agreed: true })));
  const leads = await new BusinessStore(root).listLeads();
  assert.equal(leads.length, 8); assert.equal(new Set(leads.map(lead => lead.id)).size, 8);
  assert.ok(leads.every(lead => lead.company === profile.company && lead.createdAt));
  assert.equal((await readFile(path.join(root, '.private', 'leads.ndjson'), 'utf8')).trim().split('\n').length, 8);
}));

test('reception sessions use saved facts, fixed voice and a form-opening tool', async () => temporary(async root => {
  const business = new BusinessStore(root); await business.saveProfile(profile);
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request('http://local.test', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) });
    received = JSON.parse((await request.formData()).get('session'));
    res.end('v=0\r\ns=local-answer\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const service = new RealtimeService(root, { apiKey: 'local-test', customVoiceId: 'voice_only', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }, business);
    await service.session({ sdp: 'v=0\r\n', mode: 'reception' });
    assert.ok(received.instructions.includes(profile.company) && received.instructions.includes('200 元'));
    assert.ok(received.instructions.includes('不能编造') && received.instructions.includes('未保存'));
    assert.deepEqual(received.audio.output.voice, { id: 'voice_only' });
    assert.equal(received.tools[0].name, 'open_contact_form');
    await service.session({ sdp: 'v=0\r\n', mode: 'chat' });
    assert.equal(received.tools, undefined); assert.ok(!received.instructions.includes(profile.company));
  } finally { await new Promise(resolve => upstream.close(resolve)); }
}));

test('local reception endpoints save only validated visitor submissions', async () => temporary(async root => {
  const server = createServer({ dataRoot: root }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/business', profile)).status, 200);
    assert.equal((await post('/api/leads', { contact: 'visitor@example.invalid', agreed: false })).status, 400);
    assert.equal((await post('/api/leads', { name: '测试访客', contact: 'visitor@example.invalid', agreed: true })).status, 201);
    const leads = await (await fetch(base + '/api/leads')).json(); assert.equal(leads.length, 1);
    assert.equal((await fetch(base + '/.private/leads.ndjson')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
