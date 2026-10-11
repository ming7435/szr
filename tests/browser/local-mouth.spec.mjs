import { test, expect } from '@playwright/test';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAK0lEQVQIHW3BAQEAAADBMCrJ9LBiKWBziR6X6HGJHpfocYkel+hxiR6X6BnB0Ar5y9fgkgAAAABJRU5ErkJggg==';
const pcm = Buffer.alloc(1920);
for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i * 2 * Math.PI * 240 / 24000)), i * 2);

async function create(page, delay = false, fps = 25) {
  let socket; const commands = [];
  await page.routeWebSocket('**/api/avatar/live', ws => {
    socket = ws;
    if (!delay) ws.send(JSON.stringify({ type: 'ready', fps, sampleRate: 24000, imageSize: [1145, 1374], region: [420, 460, 270, 160] }));
    ws.onMessage(data => { if (typeof data === 'string') commands.push(JSON.parse(data)); });
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { LocalMouth } = await import('/local-mouth.js');
    window.mouth = new LocalMouth({ canvas: document.getElementById('local-mouth-canvas'), image: document.getElementById('portrait'), audio: document.getElementById('remote-audio'), stage: document.getElementById('portrait-stage'), onError: error => { window.mouthError = error; } });
  });
  const pending = page.evaluate(() => mouth.connect());
  if (!delay) await pending;
  else await expect.poll(() => !!socket).toBe(true);
  return { socket, pending, commands };
}
function frames(ws, id, count = 12) {
  for (let i = 0; i < count; i++) ws.send(JSON.stringify({ type: 'frame', replyId: id, index: i, pcm: pcm.toString('base64'), jpeg: pixel }));
  ws.send(JSON.stringify({ type: 'finished', replyId: id }));
}

test('model preparation overlaps listening without playing a sound or showing a mouth frame', async ({ page }) => {
  const { commands } = await create(page);
  await expect.poll(() => commands.filter(event => event.type === 'warm').length).toBe(1);
  await page.evaluate(async () => {
    const { DoubaoConversation } = await import('/doubao-conversation.js');
    const conversation = new DoubaoConversation({ audio: document.getElementById('remote-audio'), onStatus() {} });
    conversation.renderer = mouth; conversation.videoMode = true;
    conversation.receive({ type: 'speech_started', questionId: 'listening' });
  });
  await expect.poll(() => commands.filter(event => event.type === 'warm').length).toBe(2);
  expect(await page.evaluate(() => mouth.sources.size)).toBe(0);
  expect(await page.evaluate(() => mouth.responding)).toBe(false);
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  await page.evaluate(() => mouth.disconnect());
});

test('native 20fps pairs complete 50ms audio buffers, including a short tail, on one clock', async ({ page }) => {
  const {socket}=await create(page,false,20);
  await page.evaluate(() => mouth.beginReply('native20'));
  const long=Buffer.alloc(2400);pcm.copy(long);
  for(let i=0;i<8;i++)socket.send(JSON.stringify({type:'frame',replyId:'native20',index:i,pcm:(i===7?long.subarray(0,240):long).toString('base64'),jpeg:pixel}));
  socket.send(JSON.stringify({type:'finished',replyId:'native20'}));
  await expect.poll(() => page.evaluate(() => mouth.segments.length)).toBe(8);
  const segments=await page.evaluate(() => mouth.segments);
  expect(segments[0].duration).toBe(.05);expect(segments[7].duration).toBe(.005);
  expect(segments.slice(1).every((s,i)=>Math.abs(s.start-segments[i].start-segments[i].duration)<.00001)).toBe(true);
  await page.evaluate(() => mouth.clear());await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  await page.evaluate(() => mouth.disconnect());
});

test('mouth transitions use the audible previous frame without showing future lips or retaining interrupted texture',async({page})=>{
  await create(page,false,20);
  const result=await page.evaluate(async()=>{
    cancelAnimationFrame(mouth.animation);window.requestAnimationFrame=()=>0;
    const image=color=>{const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,8,8);return createImageBitmap(c);};
    const first=await image('#ff0000'),second=await image('#0000ff');
    mouth.beginReply('smooth');mouth.timeline=[{start:10,duration:.05,bitmap:first,index:0,energy:.1},{start:10.05,duration:.05,bitmap:second,index:1,energy:.2}];
    const samples=[];
    for(const time of [10.04,10.06,10.085]){mouth.clock=()=>time;mouth.animate();samples.push([...mouth.painter.getImageData(450,500,1,1).data]);}
    const pcmChanges=mouth.sources.size;mouth.clear();const stopped=mouth.canvas.hidden;const retired=mouth.previousFrame==null;mouth.disconnect();
    return{samples,pcmChanges,stopped,retired};
  });
  expect(result.samples[0].slice(0,3)).toEqual([255,0,0]);
  expect(result.samples[1][0]).toBeGreaterThan(40);expect(result.samples[1][2]).toBeGreaterThan(40);
  expect(result.samples[2].slice(0,3)).toEqual([0,0,255]);
  expect(result.pcmChanges).toBe(0);expect(result.stopped).toBe(true);expect(result.retired).toBe(true);
});

test('a short missing mouth frame holds the last image with zero speech activity instead of flashing the still photo',async({page})=>{
  await create(page,false,20);
  const result=await page.evaluate(async()=>{
    cancelAnimationFrame(mouth.animation);window.requestAnimationFrame=()=>0;
    const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillStyle='#ff0000';c.getContext('2d').fillRect(0,0,8,8);
    const bitmap=await createImageBitmap(c);mouth.beginReply('jitter');mouth.timeline=[{start:10,duration:.05,bitmap,index:0,energy:.1}];
    mouth.clock=()=>10.04;mouth.animate();mouth.clock=()=>10.07;mouth.animate();
    const held=!mouth.canvas.hidden,energy=Number(mouth.canvas.dataset.audioEnergy);
    mouth.clock=()=>10.25;mouth.animate();const bounded=mouth.canvas.hidden;
    mouth.clear();mouth.disconnect();return {held,energy,bounded};
  });
  expect(result.held).toBe(true);expect(result.energy).toBe(0);expect(result.bounded).toBe(true);
});

test('finished speech settles to the source photo briefly and an explicit stop still hides it immediately',async({page})=>{
  await create(page,false,20);
  const result=await page.evaluate(async()=>{
    cancelAnimationFrame(mouth.animation);window.requestAnimationFrame=()=>0;
    const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillStyle='#ff0000';c.getContext('2d').fillRect(0,0,8,8);
    const bitmap=await createImageBitmap(c);mouth.beginReply('tail');mouth.timeline=[{start:10,duration:.05,bitmap,index:0,energy:.1}];mouth.finished=true;
    mouth.clock=()=>10.04;mouth.animate();mouth.clock=()=>10.085;mouth.animate();
    const settling=!mouth.canvas.hidden,energy=Number(mouth.canvas.dataset.audioEnergy);mouth.clear();const stopped=mouth.canvas.hidden;mouth.disconnect();return {settling,energy,stopped};
  });
  expect(result.settling).toBe(true);expect(result.energy).toBe(0);expect(result.stopped).toBe(true);
});

test('facial activity follows the audible frame clock and clears on interruption', async ({ page }) => {
  const {socket}=await create(page,false,20);
  await page.evaluate(() => {
    // Freeze only the visual output clock while frames decode. A real-time
    // assertion after polling can miss the 200ms startup window under load.
    mouth.clock=()=>0;mouth.beginReply('face-clock');
  });
  const voice=Buffer.alloc(2400);
  for(let i=0;i<1200;i++)voice.writeInt16LE(Math.round(5000*Math.sin(i*2*Math.PI*240/24000)),i*2);
  for(let i=0;i<8;i++)socket.send(JSON.stringify({type:'frame',replyId:'face-clock',index:i,pcm:voice.toString('base64'),jpeg:pixel}));
  await expect.poll(() => page.evaluate(() => mouth.segments.length)).toBe(8);
  // Buffered future audio must not trigger facial movement before sound begins.
  expect(await page.locator('#local-mouth-canvas').evaluate(canvas => Number(canvas.dataset.audioEnergy || 0))).toBe(0);
  await page.evaluate(() => {const first=mouth.timeline[0];mouth.clock=()=>first.start+.01;});
  await expect(page.locator('#local-mouth-canvas')).toBeVisible();
  await expect.poll(() => page.locator('#local-mouth-canvas').evaluate(canvas => Number(canvas.dataset.audioEnergy || 0))).toBeGreaterThan(.09);
  expect(await page.locator('#local-mouth-canvas').evaluate(canvas => Number(canvas.dataset.audioEnergy))).toBeLessThan(.12);
  await page.evaluate(() => mouth.clear());
  expect(await page.locator('#local-mouth-canvas').evaluate(canvas => Number(canvas.dataset.audioEnergy))).toBe(0);
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  await page.evaluate(() => mouth.disconnect());
});

test('native audio and mouth share timing; clear stops both and ignores late old frames', async ({ page }) => {
  const { socket } = await create(page);
  await page.evaluate(() => mouth.beginReply('one'));
  frames(socket, 'one');
  await expect(page.locator('#local-mouth-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => mouth.heardMilliseconds())).toBeGreaterThan(30);
  const level = await page.evaluate(async () => {
    const analyser = mouth.context.createAnalyser(); mouth.gain.connect(analyser);
    await new Promise(resolve => setTimeout(resolve, 50));
    const values = new Float32Array(1024); analyser.getFloatTimeDomainData(values);
    return values.reduce((sum, n) => sum + n * n, 0);
  });
  expect(level).toBeGreaterThan(.01);
  await page.evaluate(() => mouth.clear());
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  frames(socket, 'one');
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => mouth.sources.size)).toBe(0);
  expect(await page.evaluate(() => mouth.responding)).toBe(false);
  await page.evaluate(() => mouth.beginReply('two'));
  frames(socket, 'two');
  await expect(page.locator('#local-mouth-canvas')).toHaveAttribute('data-reply-id', 'two');
  await page.evaluate(() => mouth.disconnect());
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  await expect(page.locator('#subtitle')).toBeHidden();
});

test('JPEG decoding that finishes after interruption cannot schedule old audio', async ({ page }) => {
  const { socket } = await create(page);
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    window.createImageBitmap = async (...args) => { const result = await original(...args); await new Promise(resolve => setTimeout(resolve, 350)); return result; };
    mouth.beginReply('old');
  });
  frames(socket, 'old', 1);
  await page.waitForTimeout(30);
  await page.evaluate(() => { mouth.clear(); mouth.beginReply('new'); });
  await page.waitForTimeout(430);
  expect(await page.evaluate(() => mouth.sources.size)).toBe(0);
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  await page.evaluate(() => mouth.disconnect());
});

test('cancel while model loads resolves promptly and never restores canvas', async ({ page }) => {
  const { socket, pending } = await create(page, true);
  await page.evaluate(() => mouth.disconnect());
  await pending;
  socket.send(JSON.stringify({ type: 'ready', fps: 25, sampleRate: 24000, imageSize: [1145, 1374], region: [420, 460, 270, 160] }));
  await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  expect(await page.evaluate(() => mouth.context)).toBeNull();
});

test('streaming frame arrival jitter does not insert gaps into still-buffered audio', async ({ page }) => {
  await create(page);
  const result = await page.evaluate(async ({ pcm, jpeg }) => {
    // Hold the audio clock during asynchronous decoding. Advance it by the
    // intended arrival delay so the "still buffered" precondition is explicit.
    let time=mouth.context.currentTime;
    Object.defineProperty(mouth.context,'currentTime',{configurable:true,get:()=>time});
    mouth.beginReply('timing');
    mouth.receive({ type: 'frame', replyId: 'timing', index: 0, pcm, jpeg });
    while (mouth.segments.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    await new Promise(resolve => setTimeout(resolve, 50));
    time+=.05;const remaining=mouth.nextTime-time;
    mouth.receive({ type: 'frame', replyId: 'timing', index: 1, pcm, jpeg });
    while (mouth.segments.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const gap=mouth.segments[1].start-mouth.segments[0].start-mouth.segments[0].duration;
    delete mouth.context.currentTime;mouth.disconnect();return {gap,remaining};
  }, { pcm: pcm.toString('base64'), jpeg: pixel });
  expect(result.remaining).toBeGreaterThan(0);
  expect(Math.abs(result.gap)).toBeLessThan(.00001);
});

test('audio arriving just before the queued buffer ends remains sample-contiguous', async ({ page }) => {
  await create(page, false, 20);
  const audio=Buffer.alloc(2400);
  for(let i=0;i<1200;i++)audio.writeInt16LE(Math.round(5000*Math.sin(i*2*Math.PI*240/24000)),i*2);
  const result=await page.evaluate(async ({pcm,jpeg})=>{
    mouth.beginReply('near-end'); mouth.receive({type:'frame',replyId:'near-end',index:0,pcm,jpeg});
    while(mouth.segments.length<1)await new Promise(resolve=>setTimeout(resolve,1));
    const end=mouth.nextTime;
    // Deterministic three milliseconds of audio remain; this is not an underrun.
    Object.defineProperty(mouth.context,'currentTime',{configurable:true,get:()=>end-.003});
    mouth.receive({type:'frame',replyId:'near-end',index:1,pcm,jpeg});
    while(mouth.segments.length<2)await new Promise(resolve=>setTimeout(resolve,1));
    const gap=mouth.segments[1].start-end;
    delete mouth.context.currentTime; mouth.disconnect(); return {gap};
  },{pcm:audio.toString('base64'),jpeg:pixel});
  expect(Math.abs(result.gap)).toBeLessThan(.000001);
});
