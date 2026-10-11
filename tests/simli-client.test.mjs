import test from 'node:test';
import assert from 'node:assert/strict';
import { SimliVideo } from '../public/simli-video.js';
import { PCMResampler } from '../public/pcm-resampler.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const next = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 50; n++) { if (check()) return; await next(); } throw new Error('Fixture did not reach expected state'); }
const pcm = value => { const bytes = new Uint8Array(1200), view = new DataView(bytes.buffer); for (let i = 0; i < 600; i++) view.setInt16(i * 2, value, true); return bytes; };

function fixture(t) {
  const names = ['fetch', 'MediaStream', 'RTCPeerConnection', 'WebSocket'], original = names.map(name => globalThis[name]);
  const state = { peers: [], sockets: [], autoTracks: true, sent: [] };
  class Stream { constructor() { this.tracks = []; } addTrack(track) { this.tracks.push(track); } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); } getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); } }
  class Peer {
    constructor() { state.peers.push(this); this.iceGatheringState = 'complete'; }
    addTransceiver() {} async createOffer() { return { type: 'offer', sdp: 'test' }; } async setLocalDescription(offer) { this.localDescription = offer; }
    tracks() { for (const kind of ['audio', 'video']) this.ontrack?.({ track: { id: kind, kind, stop() {} } }); }
    close() { this.closed = true; }
  }
  class Socket {
    static OPEN = 1;
    constructor() { state.sockets.push(this); this.readyState = 1; this.bufferedAmount = 0; queueMicrotask(() => this.onopen?.()); }
    send(value) { if (value instanceof Uint8Array) state.sent.push(Buffer.from(value)); else if (value.startsWith('{') && state.autoTracks) state.peers.at(-1).tracks(); }
    close() { this.readyState = 3; }
  }
  globalThis.MediaStream = Stream; globalThis.RTCPeerConnection = Peer; globalThis.WebSocket = Socket;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sampleRate: 16000, iceServers: [], sessionToken: 'temporary-test-token' }) });
  const video = { currentTime: 0, muted: true, paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, requestVideoFrameCallback(callback) { queueMicrotask(callback); return 1; }, cancelVideoFrameCallback() {} };
  const renderer = new SimliVideo({ video, stage: { classList: { add() {}, remove() {} } } }); renderer.monitorOutput = async () => {};
  t.after(() => { renderer.disconnect(); names.forEach((name, i) => { if (original[i] === undefined) delete globalThis[name]; else globalThis[name] = original[i]; }); });
  return { ...state, state, video, renderer };
}

test('audio received while output initializes stays behind previously queued first chunk', async t => {
  const { state, renderer } = fixture(t), initialized = deferred(), release = deferred();
  renderer.monitorOutput = async () => { initialized.resolve(); await release.promise; };
  const connection = renderer.connect(); renderer.beginReply('reply'); renderer.push(pcm(1000).buffer);
  await initialized.promise; renderer.push(pcm(2000).buffer);
  assert.equal(state.sent.length, 0, 'newer audio must remain queued during initialization');
  release.resolve(); await connection; renderer.finish();
  const reference = new PCMResampler();
  assert.deepEqual(Buffer.concat(state.sent), Buffer.concat([reference.push(pcm(1000)), reference.push(pcm(2000)), reference.flush()]));
});

test('old rejected play promise cannot fail a newer connection', async t => {
  const { state, renderer, video } = fixture(t), oldPlay = deferred(); let calls = 0;
  video.play = () => ++calls === 1 ? oldPlay.promise : Promise.resolve();
  await renderer.connect(); renderer.disconnect(); state.autoTracks = false;
  let failure = null; const second = renderer.connect().catch(error => { failure = error; });
  await until(() => state.sockets.length === 2 && renderer.startReject);
  oldPlay.reject(new Error('Old AbortError')); await next(); await next();
  assert.equal(failure, null);
  state.peers.at(-1).tracks(); await second; assert.equal(failure, null); assert.equal(renderer.ready, true);
});

test('an estimated drained answer still isolates the old receiver before the next reply', async t => {
  const { state, renderer } = fixture(t); await renderer.connect(); renderer.beginReply('old'); renderer.push(pcm(1000).buffer);
  renderer.fed = false; renderer.speaking = false; renderer.awaitingOutput = false; // Receiver underrun can look quiet before delayed tail arrives.
  const oldPeer = state.peers.at(-1); renderer.clear();
  assert.equal(oldPeer.closed, true); assert.equal(renderer.video.srcObject, null);
  await until(() => renderer.ready);
});
