import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LocalAvatarService } from '../local-avatar-service.mjs';
import { createServer } from '../server.mjs';
import { WebSocket } from 'ws';

function fixture(t) {
  const commands = [], worker = new EventEmitter();
  worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.stdin = { writableLength: 0, write(line) { commands.push(JSON.parse(line)); return true; } };
  worker.kill = () => {};
  const service = new LocalAvatarService(process.cwd(), { spawn: () => worker, available: true });
  const client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0; client.events = [];
  client.send = line => client.events.push(JSON.parse(line));
  client.close = () => { client.readyState = 3; client.emit('close'); };
  t.after(() => service.close());
  return { commands, worker, service, client };
}

test('local avatar rejects old inference results after interruption and new reply', async t => {
  const { service, client, worker, commands } = fixture(t);
  const pending = service.connect(client);
  worker.stdout.write(JSON.stringify({ type: 'ready', device: 'GPU', fps: 25 }) + '\n');
  await pending;
  client.emit('message', Buffer.from(JSON.stringify({ type: 'begin', replyId: 'one' })), false);
  const old = commands.at(-1).id;
  client.emit('message', Buffer.alloc(1920), true);
  client.emit('message', Buffer.from('{"type":"clear"}'), false);
  worker.stdout.write(JSON.stringify({ type: 'frame', id: old, index: 0, pcm: 'AAA=', jpeg: 'old' }) + '\n');
  assert.equal(client.events.filter(e => e.type === 'frame').length, 0);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'begin', replyId: 'two' })), false);
  const current = commands.at(-1).id;
  assert.notEqual(current, old);
  worker.stdout.write(JSON.stringify({ type: 'frame', id: current, index: 0, pcm: 'AAA=', jpeg: 'new' }) + '\n');
  assert.equal(client.events.at(-1).replyId, 'two');
  assert.equal(client.events.at(-1).jpeg, 'new');
});

test('single client lease is held while model starts and released on disconnect', async t => {
  const { service, client, worker, commands } = fixture(t);
  const pending = service.connect(client);
  const second = new EventEmitter(); second.close = code => { second.code = code; };
  await service.connect(second);
  assert.equal(second.code, 1013);
  client.close();
  worker.stdout.write('{"type":"ready","fps":25}\n');
  await pending;
  assert.equal(client.events.length, 0);
  assert.ok(commands.some(e => e.type === 'clear'));
});

test('idle preparation warms the GPU without creating or replacing a spoken reply', async t => {
  const { service, client, worker, commands } = fixture(t);
  const pending = service.connect(client); worker.stdout.write('{"type":"ready"}\n'); await pending;
  client.emit('message', Buffer.from('{"type":"warm"}'), false);
  assert.equal(client.readyState, 1, 'Preparing an idle model must keep the conversation connected');
  assert.equal(commands.at(-1).type, 'warm');
  assert.equal(service.reply, null);
  client.emit('message', Buffer.from('{"type":"begin","replyId":"speaking"}'), false);
  const active = commands.at(-1), count = commands.length;
  client.emit('message', Buffer.from('{"type":"warm"}'), false);
  assert.equal(commands.length, count, 'Preparation must not interrupt an active reply');
  assert.equal(service.reply.id, active.id);
  worker.stdout.write(JSON.stringify({ type: 'frame', id: active.id, index: 0, pcm: 'AAA=', jpeg: 'current' }) + '\n');
  assert.equal(client.events.at(-1).replyId, 'speaking');
  client.emit('message', Buffer.from('{"type":"clear"}'), false);
  client.emit('message', Buffer.from('{"type":"warm"}'), false);
  assert.equal(commands.at(-1).type, 'warm');
  assert.equal(service.reply, null);
});

test('invalid audio, unknown commands and worker death stop the connection', async t => {
  const { service, client, worker } = fixture(t);
  const pending = service.connect(client); worker.stdout.write('{"type":"ready"}\n'); await pending;
  client.emit('message', Buffer.from('{"type":"begin","replyId":"one"}'), false);
  client.emit('message', Buffer.from([1]), true);
  assert.equal(client.readyState, 3);
  assert.ok(client.events.some(e => e.type === 'error'));
  worker.emit('exit', 1);
  assert.equal(service.ready, null);
});

test('late exit from a failed worker cannot cancel a newly connected worker', async t => {
  const { service, client, worker } = fixture(t);
  const first = service.connect(client); worker.stdout.write('{"type":"ready"}\n'); await first;
  worker.stdout.write('bad-json\n');
  const replacement = new EventEmitter(); replacement.stdout = new PassThrough(); replacement.stderr = new PassThrough();
  replacement.stdin = { writableLength: 0, write() {} }; replacement.kill = () => {};
  service.options.spawn = () => replacement;
  const second = new EventEmitter(); second.readyState = 1; second.bufferedAmount = 0; second.send = () => {}; second.close = () => { second.readyState = 3; second.emit('close'); };
  const pending = service.connect(second); replacement.stdout.write('{"type":"ready"}\n'); await pending;
  worker.emit('exit', 1);
  assert.equal(second.readyState, 1);
  assert.ok(service.ready);
});

test('foreign and missing origins cannot start the local model through websocket routing', async t => {
  const { service, commands } = fixture(t);
  const server = createServer({ localAvatar: service, localVoice: { publicStatus: async () => ({}), close() {} }, chatgpt: { publicSession: async () => ({}), cancelSignIn() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `ws://127.0.0.1:${server.address().port}/api/avatar/live`;
  for (const options of [{ origin: 'https://foreign.example' }, {}, { origin: 'http://foreign.example', headers: { Host: 'foreign.example' } }]) {
    await assert.rejects(new Promise((resolve, reject) => { const client = new WebSocket(url, options); client.once('open', () => { client.close(); resolve(); }); client.once('error', reject); }), /403/);
  }
  assert.equal(commands.length, 0); assert.equal(service.worker, undefined);
});
