// Offline replay through the actual page, native GPU mouth and audio clock.
// The speech socket is controlled; no cloud calls or physical microphone/audio.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const base='http://127.0.0.1:4192', directory='output/avatar-coordination';
await mkdir(directory,{recursive:true});
const wav=await readFile('output/doubao-live-reply.wav');
let pcm,rate,channels,bits;
for(let at=12;at+8<=wav.length;){
  const name=wav.toString('ascii',at,at+4),size=wav.readUInt32LE(at+4),start=at+8;
  if(name==='fmt '){assert.equal(wav.readUInt16LE(start),1);channels=wav.readUInt16LE(start+2);rate=wav.readUInt32LE(start+4);bits=wav.readUInt16LE(start+14);}
  if(name==='data')pcm=wav.subarray(start,start+size);
  at=start+size+(size%2);
}
assert.equal(rate,24000);assert.equal(channels,1);assert.equal(bits,16);assert.ok(pcm.length);
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let voice;
  await page.route('**/api/config',route=>route.fulfill({json:{apiConfigured:false,chatgpt:{sharing:false},doubao:{selected:true,configured:true,voice:'uploaded-reference',voiceId:'S_dCBmWoBh2'},simli:{enabled:false},localAvatar:{enabled:true}}}));
  await page.routeWebSocket('**/api/doubao/live',ws=>{
    voice=ws;
    ws.onMessage(data=>{if(typeof data==='string'&&JSON.parse(data).type==='start')ws.send(JSON.stringify({type:'ready',voice:'uploaded-reference',sampleRate:24000}));});
  });
  await page.addInitScript(()=>{
    window.coordinationProbe={frames:0,paired:[],starts:[],samples:[]};
    const NativeSocket=WebSocket;
    window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);if(!String(args[0]).includes('/api/avatar/live'))return;this.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.type==='frame'){coordinationProbe.frames++;coordinationProbe.paired.push(data.pcm);}});}};
    const native=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(...args){const source=native.apply(this,args),start=source.start.bind(source);source.start=time=>{coordinationProbe.starts.push({time,duration:source.buffer.duration});start(time);};return source;};
    document.addEventListener('DOMContentLoaded',()=>{
      const sample=time=>{
        const mouth=document.getElementById('local-mouth-canvas'),eyes=document.getElementById('face-expression-canvas'),head=document.getElementById('portrait-layers'),hands=document.querySelector('.hand-motion');
        if(hands&&coordinationProbe.samples.length<2400)coordinationProbe.samples.push({time,status:document.getElementById('avatar-status').textContent,mouth:!mouth.hidden,energy:Number(mouth.dataset.audioEnergy||0),eyePose:eyes.dataset.pose,pitch:Number(head.dataset.pitch||0),yaw:Number(head.dataset.yaw||0),hands:!hands.hidden,strength:Number(hands.dataset.gestureStrength||0)});
        requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    });
  });
  await page.goto(base+'/');
  await page.waitForFunction(()=>document.querySelector('.hand-motion')?.dataset.ready==='true'&&document.getElementById('face-expression-canvas').dataset.ready==='true'&&document.getElementById('portrait-layers').dataset.motionReady==='true');
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.getElementById('connection-summary').textContent==='语音对话已连接');
  await page.locator('#mute').click();
  await page.locator('#portrait-stage').screenshot({path:`${directory}/listening.png`});
  voice.send(JSON.stringify({type:'speech_stopped',questionId:'offline-guide'}));
  await page.waitForTimeout(1600);
  await page.locator('#portrait-stage').screenshot({path:`${directory}/thinking.png`});
  voice.send(JSON.stringify({type:'response_started',replyId:'coordination',questionId:'offline-guide'}));
  voice.send(pcm);
  voice.send(JSON.stringify({type:'response_ended',replyId:'coordination'}));
  await page.waitForFunction(()=>Number(document.querySelector('.hand-motion').dataset.gestureStrength)>.5,null,{timeout:45000});
  await page.locator('#portrait-stage').screenshot({path:`${directory}/speaking.png`});
  await page.waitForFunction(()=>coordinationProbe.frames>0&&document.getElementById('local-mouth-canvas').hidden&&document.getElementById('avatar-status').textContent==='我正在听',null,{timeout:45000});
  const result=await page.evaluate(()=>({...coordinationProbe,handsHidden:document.querySelector('.hand-motion').hidden,subtitleHidden:document.getElementById('subtitle').hidden,chatHidden:document.getElementById('chat').hidden}));
  const speaking=result.samples.filter(s=>s.mouth&&s.energy>0),gaps=result.starts.slice(1).map((entry,i)=>entry.time-result.starts[i].time-result.starts[i].duration);
  const eyePoses=[...new Set(speaking.map(s=>s.eyePose))],headPoses=new Set(speaking.map(s=>`${s.pitch},${s.yaw}`));
  assert.equal(result.frames,Math.ceil(pcm.length/2400));
  assert.deepEqual(Buffer.concat(result.paired.map(b=>Buffer.from(b,'base64'))),pcm);
  assert.ok(gaps.every(gap=>Math.abs(gap)<.00001),'Native audio acquired a playback gap');
  assert.ok(speaking.some(s=>s.hands&&s.strength>.5),'Real playback failed to move hands');
  assert.ok(eyePoses.some(p=>/^blink\d+$/.test(p)),'Eyes did not blink during actual speech');
  assert.ok(headPoses.size>10,'Head did not follow audible speech');
  assert.equal(result.handsHidden,true);assert.equal(result.subtitleHidden,true);assert.equal(result.chatHidden,true);
  // Replay a second reply and interrupt while a gesture is active.
  voice.send(JSON.stringify({type:'response_started',replyId:'interrupt',questionId:'offline-guide-2'}));voice.send(pcm);
  await page.waitForFunction(()=>Number(document.querySelector('.hand-motion').dataset.gestureStrength)>.3,null,{timeout:45000});
  await page.locator('#interrupt').click();
  const interrupted=await page.evaluate(()=>document.getElementById('local-mouth-canvas').hidden&&document.querySelector('.hand-motion').hidden&&Number(document.querySelector('.hand-motion').dataset.gestureStrength)===0);
  assert.equal(interrupted,true);
  await page.locator('#motion-toggle').click();
  await page.waitForFunction(()=>document.getElementById('face-expression-canvas').hidden&&document.getElementById('portrait-layers').style.filter==='');
  await page.locator('#connect').click();assert.deepEqual(errors,[]);
  await writeFile(`${directory}/timing.json`,JSON.stringify(result,null,2));
  const report={passed:true,checkedAt:new Date().toISOString(),actualGPUAndChrome:true,cloudCalls:0,physicalMicrophone:false,physicalAudio:false,frames:result.frames,originalPcmUnchanged:true,audioGaps:0,eyePoses,headPosesDuringSpeech:headPoses.size,maxHandStrength:Math.max(...speaking.map(s=>s.strength)),wristSettlesAtEnd:result.handsHidden,interruptClearsImmediately:interrupted,motionSwitchStopsEyesHeadAndHands:true,voiceOnly:true,pageErrors:errors};
  await writeFile(`${directory}/browser-verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
