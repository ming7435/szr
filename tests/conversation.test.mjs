import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeConversation } from '../public/realtime.js';

function conversation() {
  const messages = new Map(), statuses = [];
  const client = new RealtimeConversation({ audio: { pause() {}, srcObject: null }, onMessage: (role, text, id, pending) => messages.set(id, { role, text, pending }), onStatus: status => statuses.push(status) });
  return { client, messages, statuses };
}

test('reception tool opens a form once without claiming a saved lead', async () => {
  const calls = [], sent = [];
  const client = new RealtimeConversation({ audio: { pause() {} }, onToolCall: async (name, args) => { calls.push({ name, args }); return { status: 'form_opened', saved: false }; } });
  client.channel = { readyState: 'open', send: message => sent.push(JSON.parse(message)) };
  const event = { type: 'response.done', response: { id: 'reception1', status: 'completed', output: [{ type: 'function_call', name: 'open_contact_form', call_id: 'lead1', arguments: '{"interest":"产品咨询"}' }] } };
  client.handleEvent(event); client.handleEvent(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(sent[0].item.output).saved, false);
  assert.equal(sent.filter(item => item.type === 'response.create').length, 1);
});

test('cancelled responses cannot open a visitor form', async () => {
  let opened = false;
  const client = new RealtimeConversation({ audio: { pause() {} }, onToolCall: () => { opened = true; } });
  client.cancelled.add('cancelled-reception');
  client.handleEvent({ type: 'response.done', response: { id: 'cancelled-reception', status: 'cancelled', output: [{ type: 'function_call', name: 'open_contact_form', call_id: 'lead2', arguments: '{}' }] } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, false);
});

test('input transcript deltas and completion update the same user message', () => {
  const { client, messages } = conversation();
  client.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'user1' });
  client.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user1', delta: '你好' });
  client.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user1', transcript: '你好，今天怎么样？' });
  assert.equal(messages.size, 1); assert.deepEqual(messages.get('user1'), { role: 'user', text: '你好，今天怎么样？', pending: false });
});

test('user interruption freezes the cancelled assistant transcript', () => {
  const { client, messages, statuses } = conversation();
  client.handleEvent({ type: 'response.created', response: { id: 'response1' } });
  client.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'response1', item_id: 'assistant1', delta: '你好，' });
  client.handleEvent({ type: 'output_audio_buffer.started', response_id: 'response1' });
  client.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'user2' });
  client.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'response1', item_id: 'assistant1', delta: '这句话不应继续显示。' });
  client.handleEvent({ type: 'response.done', response: { id: 'response1', status: 'cancelled' } });
  assert.equal(messages.get('assistant1').text, '你好，'); assert.equal(statuses.at(-1), '你在说，我在听');
});

test('generation finishing does not mark audio playback as finished', () => {
  const { client, statuses } = conversation();
  client.handleEvent({ type: 'response.created', response: { id: 'response2' } });
  client.handleEvent({ type: 'output_audio_buffer.started', response_id: 'response2' });
  client.handleEvent({ type: 'response.done', response: { id: 'response2', status: 'completed' } });
  assert.equal(statuses.at(-1), '我正在回应');
  client.handleEvent({ type: 'output_audio_buffer.stopped', response_id: 'response2' });
  assert.equal(statuses.at(-1), '正在听你说');
});

test('manual interruption cancels generation and clears buffered playback', () => {
  const { client } = conversation(); const sent = [];
  client.channel = { readyState: 'open', send: value => sent.push(JSON.parse(value)) };
  client.handleEvent({ type: 'response.created', response: { id: 'response3' } });
  client.handleEvent({ type: 'output_audio_buffer.started', response_id: 'response3' });
  client.interrupt();
  assert.deepEqual(sent, [{ type: 'response.cancel', response_id: 'response3' }, { type: 'output_audio_buffer.clear' }]);
});

test('interrupting a new response before its transcript does not mark a previous completed reply', () => {
  const interrupted = [];
  const client = new RealtimeConversation({ audio: { pause() {} }, onInterruption: id => interrupted.push(id) });
  client.handleEvent({ type: 'response.created', response: { id: 'old-response' } });
  client.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'old-response', item_id: 'old-item', delta: '已经完成的回答。' });
  client.handleEvent({ type: 'response.done', response: { id: 'old-response', status: 'completed' } });
  client.handleEvent({ type: 'output_audio_buffer.stopped', response_id: 'old-response' });
  client.handleEvent({ type: 'response.created', response: { id: 'new-response' } });
  client.handleEvent({ type: 'input_audio_buffer.speech_started', item_id: 'user-new' });
  assert.deepEqual(interrupted, []);
});
