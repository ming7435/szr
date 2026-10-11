// Actual local GPU and native Chrome playback, with an existing cloned-voice reply.
// This check uses no cloud quota or physical microphone.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const wav = await readFile('output/doubao-live-reply.wav');
let pcm, rate, channels, bits;
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
for (let at = 12; at + 8 <= wav.length;) {
 const name=wav.toString('ascii',at,at+4), size=wav.readUInt32LE(at+4), start=at+8;
 if(name==='fmt '){assert.equal(wav.readUInt16LE(start),1);channels=wav.readUInt16LE(start+2);rate=wav.readUInt32LE(start+4);bits=wav.readUInt16LE(start+14);}
 if(name==='data')pcm=wav.subarray(start,start+size);
 at=start+size+(size%2);
}
assert.equal(rate,24000);assert.equal(channels,1);assert.equal(bits,16);assert.ok(pcm.length);
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.qualityProbe={starts:[],paired:[],frames:0};const native=AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource=function(...args){const source=native.apply(this,args);const start=source.start.bind(source);source.start=time=>{qualityProbe.starts.push({time,duration:source.buffer.duration});start(time);};return source;};
  const NativeSocket=WebSocket;
  window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);if(!String(args[0]).includes('/api/avatar/live'))return;this.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.type==='ready')qualityProbe.detail=data.mouthDetail;if(data.type==='frame'){qualityProbe.frames++;qualityProbe.paired.push(data.pcm);}});}};
 });
 await page.goto('http://127.0.0.1:4173/');
 await page.evaluate(async encoded=>{
  const {LocalMouth}=await import('/local-mouth.js');const image=document.getElementById('portrait');
  const canvas=document.getElementById('local-mouth-canvas');const stage=document.getElementById('portrait-stage');
  window.qualityRenderer=new LocalMouth({image,canvas,stage,audio:document.getElementById('remote-audio'),onError:error=>qualityProbe.error=error});
  await qualityRenderer.connect();qualityRenderer.beginReply('quality-browser');qualityRenderer.push(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));qualityRenderer.finish();
 },pcm.toString('base64'));
 await page.waitForFunction(()=>qualityProbe.error || (qualityProbe.frames>0&&!qualityRenderer.responding&&qualityRenderer.canvas.hidden),null,{timeout:45000});
 const result=await page.evaluate(()=>({...qualityProbe,lastDrawn:qualityRenderer.drawnIndex,canvasHidden:qualityRenderer.canvas.hidden}));
 assert.equal(result.error,undefined);assert.equal(result.detail,'GPEN-256-motion');assert.equal(result.frames,189);
 // The final five-ms partial audio frame can fall between display refreshes.
 const lastFullFrame=Math.floor(pcm.length/1920)-1;
 assert.ok(result.lastDrawn>=lastFullFrame);assert.equal(result.canvasHidden,true);
 const paired=Buffer.concat(result.paired.map(b=>Buffer.from(b,'base64')));assert.deepEqual(paired,pcm);assert.equal(result.starts.length,189);
 const gaps=result.starts.slice(1).map((entry,i)=>entry.time-result.starts[i].time-result.starts[i].duration);
 assert.ok(gaps.every(gap=>Math.abs(gap)<.00001),'Actual GPU/browser playback inserted an audio gap');
 await page.evaluate(()=>qualityRenderer.disconnect());assert.deepEqual(errors,[]);
 const report={passed:true,checkedAt:new Date().toISOString(),actualGPUAndChrome:true,cloudCalls:0,physicalMicrophone:false,frames:189,outputFPS:25,originalPcmUnchanged:true,audioGaps:0,lastDrawn:result.lastDrawn,finalFullLengthFrameReached:true,partialTailMayFallBetweenRefreshes:true,photoRestoredAtEnd:true,pageErrors:errors};
 await writeFile('output/mouth-quality-probe/browser-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
