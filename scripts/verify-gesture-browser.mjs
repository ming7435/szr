// Full page, original prior cloned PCM, cached native frames. No cloud or GPU inference.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const output = 'output/gesture-browser-verification.json';
const wav = await readFile('output/doubao-live-reply.wav'); let pcm;
for(let at=12;at+8<=wav.length;){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data')pcm=wav.subarray(at+8,at+8+size);at+=8+size+(size%2);}
assert.ok(pcm?.length); const count = Math.ceil(pcm.length/2400);
const cached = JSON.parse(await readFile('output/gesture-replay-frames.json','utf8'));
assert.equal(cached.frames.length,count);assert.deepEqual(cached.region,[391,476,336,151]);
const images = cached.frames;
let voicedIndex=0,peak=0;for(let i=0;i<count;i++){const chunk=pcm.subarray(i*2400,(i+1)*2400);let power=0;for(let at=0;at+1<chunk.length;at+=2)power+=(chunk.readInt16LE(at)/32768)**2;power/=chunk.length/2;if(power>peak){peak=power;voicedIndex=i;}}
assert.ok(Math.sqrt(peak)>.03);const voicedPcm=pcm.subarray(voicedIndex*2400,(voicedIndex+1)*2400);
const config = await (await fetch('http://127.0.0.1:4173/api/config')).json();
assert.equal(config.doubao.voiceId, 'S_dCBmWoBh2'); assert.equal(config.localAvatar.enabled, true);
const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] }); let timer;
try {
 const page = await browser.newPage({ viewport:{width:1440,height:1100}, deviceScaleFactor:2, permissions:['microphone'] }); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('/api/config', route => route.fulfill({json:config})); let voice, lips;
 await page.routeWebSocket('**/api/doubao/live', ws => { voice=ws;ws.onMessage(data=>{if(typeof data==='string'&&JSON.parse(data).type==='start')ws.send(JSON.stringify({type:'ready',voice:'uploaded-reference',sampleRate:24000}));}); });
 await page.routeWebSocket('**/api/avatar/live', ws => { lips=ws;ws.send(JSON.stringify({type:'ready',fps:20,sampleRate:24000,imageSize:[1145,1374],region:[391,476,336,151]})); });
 await page.addInitScript(()=>{
  window.gestureProbe={starts:[],pcm:[],frames:[],strengths:[],raf:[]};const native=AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource=function(...args){const source=native.apply(this,args),start=source.start.bind(source);source.start=time=>{gestureProbe.starts.push({time,duration:source.buffer.duration});const values=source.buffer.getChannelData(0),bytes=new Uint8Array(values.length*2),view=new DataView(bytes.buffer);for(let i=0;i<values.length;i++)view.setInt16(i*2,Math.round(values[i]*32768),true);gestureProbe.pcm.push(btoa(String.fromCharCode(...bytes)));start(time);};return source;};
  document.addEventListener('DOMContentLoaded',()=>{const mouth=document.getElementById('local-mouth-canvas');new MutationObserver(()=>{if(!mouth.hidden)gestureProbe.frames.push(Number(mouth.dataset.frameIndex));}).observe(mouth,{attributes:true,attributeFilter:['data-frame-index']});let last=performance.now();function tick(){const now=performance.now();if(!mouth.hidden){gestureProbe.raf.push(now-last);const hand=document.querySelector('.hand-motion');if(hand&&!hand.hidden)gestureProbe.strengths.push(Number(hand.dataset.gestureStrength));}last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);});
 });
 await page.goto('http://127.0.0.1:4173/');await page.waitForFunction(()=>document.querySelector('.hand-motion')?.dataset.ready==='true'&&document.getElementById('portrait-layers').dataset.motionReady==='true');
 await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('connection-summary').textContent==='语音对话已连接');await page.locator('#mute').click();
 voice.send(JSON.stringify({type:'response_started',replyId:'gesture-probe',questionId:'offline'}));
 let index=0;const started=performance.now();timer=setInterval(()=>{const due=Math.min(count,Math.floor((performance.now()-started)/100)*2);while(index<due){lips.send(JSON.stringify({type:'frame',replyId:'gesture-probe',index,pcm:pcm.subarray(index*2400,(index+1)*2400).toString('base64'),jpeg:images[index%images.length]}));index++;}if(index===count){clearInterval(timer);lips.send(JSON.stringify({type:'finished',replyId:'gesture-probe'}));voice.send(JSON.stringify({type:'response_ended',replyId:'gesture-probe'}));}},10);
 await page.waitForFunction(()=>gestureProbe.strengths.some(n=>n>.5));
 await page.waitForFunction(()=>gestureProbe.frames.length&&document.getElementById('local-mouth-canvas').hidden&&document.getElementById('avatar-status').textContent==='我正在听',null,{timeout:20000});
 const result=await page.evaluate(()=>{const r=gestureProbe.raf.slice().sort((a,b)=>a-b);return{...gestureProbe,drawnFrames:new Set(gestureProbe.frames).size,rafMedian:r[Math.floor(r.length*.5)],rafP95:r[Math.floor(r.length*.95)],maxGesture:Math.max(...gestureProbe.strengths),handsHidden:document.querySelector('.hand-motion').hidden,captionHidden:document.getElementById('subtitle').hidden};});
 const gaps=result.starts.slice(1).map((s,i)=>s.time-result.starts[i].time-result.starts[i].duration).filter(n=>Math.abs(n)>.00001);
 assert.deepEqual(Buffer.concat(result.pcm.map(n=>Buffer.from(n,'base64'))),pcm);assert.equal(gaps.length,0);assert.ok(result.drawnFrames>=count*.95);assert.ok(result.maxGesture>.5);assert.equal(result.handsHidden,true);assert.equal(result.captionHidden,true);
 await page.locator('#motion-toggle').click();assert.equal(await page.locator('.hand-motion').isVisible(),false);await page.locator('#motion-toggle').click();
 voice.send(JSON.stringify({type:'response_started',replyId:'interrupt-gesture'}));for(let i=0;i<60;i++)lips.send(JSON.stringify({type:'frame',replyId:'interrupt-gesture',index:i,pcm:voicedPcm.toString('base64'),jpeg:images[voicedIndex]}));
 await page.waitForFunction(()=>Number(document.querySelector('.hand-motion').dataset.gestureStrength)>.5);await page.screenshot({path:'output/gesture-speaking.png'});await page.locator('#interrupt').click();assert.equal(await page.locator('.hand-motion').isVisible(),false);assert.equal(await page.locator('#local-mouth-canvas').isVisible(),false);
 await page.locator('#connect').click();assert.deepEqual(errors,[]);
 const report={passed:true,checkedAt:new Date().toISOString(),cachedNativeFrames:true,actualGPUInference:false,cloudCalls:0,physicalMicrophone:false,deviceScaleFactor:2,frames:count,drawnFrames:result.drawnFrames,rafMedianMs:result.rafMedian,rafP95Ms:result.rafP95,maximumGestureStrength:result.maxGesture,originalClonedPcmUnchanged:true,audioGaps:0,handsStopAtEnd:true,interruptionStopsHandsAndMouth:true,captionHidden:true,voiceIdPreserved:config.doubao.voiceId,pageErrors:errors};await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(output,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),error:error.message},null,2));throw error;}finally{clearInterval(timer);await browser.close();}
