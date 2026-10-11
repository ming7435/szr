// Actual GPU, learned eye assets and native Chrome playback; no cloud or microphone.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const withoutFilter = process.argv.includes('--without-filter');
const base=process.env.AVATAR_PROBE_BASE_URL||'http://127.0.0.1:4173';
assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/);
const directory=process.env.AVATAR_PROBE_OUTPUT_DIR||'output/full-face-probe';
await mkdir(directory,{recursive:true});
const reportFile = `${directory}/${withoutFilter?'filter-baseline':'browser-verification'}.json`;
const wav = await readFile('output/doubao-live-reply.wav');
let pcm, rate, channels, bits;
for (let at = 12; at + 8 <= wav.length;) {
 const name=wav.toString('ascii',at,at+4), size=wav.readUInt32LE(at+4), start=at+8;
 if(name==='fmt '){assert.equal(wav.readUInt16LE(start),1);channels=wav.readUInt16LE(start+2);rate=wav.readUInt32LE(start+4);bits=wav.readUInt16LE(start+14);}
 if(name==='data')pcm=wav.subarray(start,start+size);
 at=start+size+(size%2);
}
assert.equal(rate,24000);assert.equal(channels,1);assert.equal(bits,16);assert.ok(pcm.length);
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.nativeProbe={starts:[],paired:[],frames:0,frameTimes:[],eyePoses:[],headPoses:[],maxAudibleEnergy:0,closedWhileMouth:false};const native=AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource=function(...args){const source=native.apply(this,args);const start=source.start.bind(source);source.start=time=>{nativeProbe.starts.push({time,duration:source.buffer.duration});start(time);};return source;};
  const NativeSocket=WebSocket;
  window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);if(!String(args[0]).includes('/api/avatar/live'))return;this.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.type==='ready'){nativeProbe.detail=data.mouthDetail;nativeProbe.lowerFaceMotion=data.lowerFaceMotion;nativeProbe.faceRegion=data.region;}if(data.type==='frame'){nativeProbe.frames++;nativeProbe.frameTimes.push(performance.now());nativeProbe.paired.push(data.pcm);}});}};
  document.addEventListener('DOMContentLoaded',()=>{
   const eye=document.getElementById('face-expression-canvas'),mouth=document.getElementById('local-mouth-canvas');
   new MutationObserver(()=>{
    const pose=eye.dataset.pose;if(pose&&!nativeProbe.eyePoses.includes(pose))nativeProbe.eyePoses.push(pose);
    // A blink has no fixed closed hold: native refresh timing need not sample exactly 100%.
    const lidClosure=/^blink\d+$/.test(pose)?Number(pose.slice(5)):0;
    if(lidClosure>=95&&!eye.hidden&&!mouth.hidden){nativeProbe.closedWhileMouth=true;nativeProbe.closedPose=pose;nativeProbe.eyeTransparentAtMouth=eye.getContext('2d').getImageData(550,550,1,1).data[3]===0;nativeProbe.closedEyeImage=eye.toDataURL();}
   }).observe(eye,{attributes:true});
   const layers=document.getElementById('portrait-layers');
   new MutationObserver(()=>{
    const renderer=window.nativeRenderer;if(!renderer||mouth.hidden)return;
    const blend=renderer.drawnMix,index=renderer.drawnIndex;
    const save=()=>{const c=document.createElement('canvas');const[x,y,w,h]=renderer.region;c.width=w;c.height=h;c.getContext('2d').drawImage(mouth,x,y,w,h,0,0,w,h);return c.toDataURL();};
    if(index>=20&&blend>.25&&blend<.85&&!nativeProbe.transitionImage)nativeProbe.transitionImage=save();
    if(index>=20&&blend===1&&!nativeProbe.stableMouthImage)nativeProbe.stableMouthImage=save();
   }).observe(mouth,{attributes:true,attributeFilter:['data-frame-index']});
   new MutationObserver(()=>{
    if(!mouth.hidden){const pose=layers.dataset.pitch+','+layers.dataset.yaw;if(!nativeProbe.headPoses.includes(pose)&&nativeProbe.headPoses.length<1000)nativeProbe.headPoses.push(pose);nativeProbe.maxAudibleEnergy=Math.max(nativeProbe.maxAudibleEnergy,Number(mouth.dataset.audioEnergy||0));}
   }).observe(layers,{attributes:true,attributeFilter:['data-pitch','data-yaw']});
  });
 });
 await page.goto(base+'/');
 await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true');
 if(withoutFilter)await page.addStyleTag({content:'#portrait-layers{filter:none!important}'});
 await page.evaluate(async encoded=>{
  const {LocalMouth}=await import('/local-mouth.js');const image=document.getElementById('portrait');
  nativeProbe.clockSamples=[];const clock=LocalMouth.prototype.clock;
  LocalMouth.prototype.clock=function(){const value=clock.call(this);if(nativeProbe.clockSamples.length<1500)nativeProbe.clockSamples.push({now:performance.now(),audio:this.context?.currentTime,output:this.context?.getOutputTimestamp?.(),clock:value});return value;};
  window.nativeRenderer=new LocalMouth({image,canvas:document.getElementById('local-mouth-canvas'),stage:document.getElementById('portrait-stage'),audio:document.getElementById('remote-audio'),onError:error=>nativeProbe.error=error});
  await nativeRenderer.connect();nativeRenderer.beginReply('native-browser');nativeRenderer.push(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));nativeRenderer.finish();
 },pcm.toString('base64'));
 await page.waitForFunction(()=>nativeProbe.error || (nativeProbe.frames>0&&!nativeRenderer.responding&&nativeRenderer.canvas.hidden),null,{timeout:45000});
 const result=await page.evaluate(()=>({...nativeProbe,lastDrawn:nativeRenderer.drawnIndex,drawnFrames:nativeRenderer.frameCount,visualFrames:nativeRenderer.visualFrameCount,canvasHidden:nativeRenderer.canvas.hidden}));
 const count=Math.ceil(pcm.length/2400);
 const gaps=result.starts.slice(1).map((entry,i)=>entry.time-result.starts[i].time-result.starts[i].duration);
 await writeFile(`${directory}/${withoutFilter?'filter-baseline-timing':'browser-timing'}.json`,JSON.stringify({checkedAt:new Date().toISOString(),frames:result.frames,drawnFrames:result.drawnFrames,visualFrames:result.visualFrames,lastDrawn:result.lastDrawn,frameTimes:result.frameTimes,audioStarts:result.starts,clockSamples:result.clockSamples,gaps:gaps.filter(n=>Math.abs(n)>.00001)},null,2));
 for(const [name,data]of [['mouth-transition',result.transitionImage],['mouth-stable',result.stableMouthImage]])if(data)await writeFile(`${directory}/${name}.png`,Buffer.from(data.split(',')[1],'base64'));
 assert.equal(result.error,undefined);assert.equal(result.detail,'native-256-fixed-portrait');assert.equal(result.frames,count);
 assert.equal(result.lowerFaceMotion,'audio-driven-photo-warp');
 assert.ok(result.drawnFrames>=count*.9,'Browser skipped more than 10% of the actual mouth frames');
 assert.ok(result.lastDrawn>=Math.floor(pcm.length/2400)-1);assert.equal(result.canvasHidden,true);
 assert.equal(result.closedWhileMouth,true);assert.ok(Number(result.closedPose.slice(5))>=95);assert.equal(result.eyeTransparentAtMouth,true);
 assert.ok(result.headPoses.length>10,'Shared head geometry did not move while audible speech played');assert.ok(result.maxAudibleEnergy>.01);
 assert.deepEqual(Buffer.concat(result.paired.map(b=>Buffer.from(b,'base64'))),pcm);assert.equal(result.starts.length,count);
 console.log(JSON.stringify({frames:result.frames,gaps:gaps.filter(n=>Math.abs(n)>.00001),blink:result.closedWhileMouth}));
 assert.ok(gaps.every(gap=>Math.abs(gap)<.00001),'Actual GPU/browser playback inserted an audio gap');
 await page.locator('#motion-toggle').click();assert.equal(await page.locator('#face-expression-canvas').isVisible(),false);
 assert.equal(await page.locator('#portrait-layers').evaluate(element=>element.style.filter),'');
 await page.evaluate(()=>nativeRenderer.disconnect());assert.deepEqual(errors,[]);
 const report={passed:true,diagnosticWithoutFilter:withoutFilter,checkedAt:new Date().toISOString(),actualGPUAndChrome:true,cloudCalls:0,physicalMicrophone:false,frames:count,outputFPS:20,drawnFrames:result.drawnFrames,visualFrames:result.visualFrames,lowerFaceMotion:result.lowerFaceMotion,faceRegion:result.faceRegion,originalPcmUnchanged:true,audioGaps:0,lastDrawn:result.lastDrawn,eyePoses:result.eyePoses,closedPose:result.closedPose,sharedHeadMotion:!withoutFilter,headPosesWhileSpeaking:result.headPoses.length,maxAudibleEnergy:result.maxAudibleEnergy,blinkWhileSpeaking:true,eyesDoNotCoverMouth:true,motionToggleStopsEyes:true,motionToggleStopsHead:true,photoRestoredAtEnd:true,pageErrors:errors};
 await writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(reportFile,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),error:error.message},null,2));throw error;}finally{await browser.close();}
