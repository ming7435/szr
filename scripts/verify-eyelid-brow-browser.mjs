// Actual photo and production expression renderer; controlled clock, no microphone/cloud/inference.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const output = 'output/eyelid-brow-verification.json';
const config = await (await fetch('http://127.0.0.1:4173/api/config')).json();
assert.equal(config.doubao.voiceId, 'S_dCBmWoBh2');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/eyelid-check', route => route.fulfill({ contentType: 'text/html', body: '<img id="photo" src="/assets/avatar.png"><canvas id="eyes"></canvas>' }));
  await page.goto('http://127.0.0.1:4173/eyelid-check');
  const frames = await page.evaluate(async () => {
    const { FaceExpression } = await import('/face-expression.js');
    const canvas = document.getElementById('eyes'), image = document.getElementById('photo');
    const face = new FaceExpression({ canvas, image });
    if (!await face.load()) throw new Error('Photo-bound eye assets unavailable');
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); face.raf = 0; face.timer = 0;
    window.requestAnimationFrame = () => 0;
    const scene = document.createElement('canvas'); scene.width = canvas.width; scene.height = canvas.height;
    const c = scene.getContext('2d', { willReadFrequently: true });
    const crop = document.createElement('canvas'); crop.width = 248; crop.height = 124;
    const cropped = crop.getContext('2d');
    const points = [[488,408], [619,399]];
    c.drawImage(image, 0, 0); const originalEyes = points.map(([x,y]) => [...c.getImageData(x,y,1,1).data]);
    const paint = () => { c.drawImage(image,0,0); c.drawImage(canvas,0,0); };
    const brows = () => [c.getImageData(441,344,96,37).data, c.getImageData(574,341,91,34).data].map(values=>[...values]);
    face.state = 'listening'; face.intensity = face.target = .7; face.tick(1000); paint();
    const before = brows(), openEyes = points.map(([x,y]) => [...c.getImageData(x,y,1,1).data]);
    face.blinkStart = 1000; const snapshots = [], differences = [], draws = []; let closedEyes;
    for(let elapsed=0;elapsed<=300;elapsed+=5) {
      const start = performance.now(); face.tick(1000+elapsed); draws.push(performance.now()-start); paint();
      const current = brows(); differences.push(Math.max(...current.flatMap((values,k)=>values.map((v,i)=>Math.abs(v-before[k][i])))));
      if(elapsed===70) closedEyes=points.map(([x,y])=>[...c.getImageData(x,y,1,1).data]);
      cropped.drawImage(scene,428,330,248,124,0,0,248,124);
      snapshots.push({elapsed,png:crop.toDataURL('image/png').split(',')[1]});
    }
    const after = brows(); const reopeningBrowDifference = Math.max(...after.flatMap((values,k)=>values.map((v,i)=>Math.abs(v-before[k][i]))));
    const cachedLidFrames = face.blinkSequence.length;
    face.dispose();
    return {snapshots, originalEyes, openEyes, closedEyes, cachedLidFrames, maximumBrowDifference:Math.max(...differences), reopeningBrowDifference, maxDrawMs:Math.max(...draws), disposed:face.bitmaps.size===0&&!face.blinkFrames.size};
  });
  assert.deepEqual(frames.originalEyes, frames.openEyes);
  assert.ok(frames.maximumBrowDifference<=1);
  assert.ok(frames.reopeningBrowDifference<=1);
  for(let eye=0;eye<2;eye++)assert.notDeepEqual(frames.closedEyes[eye],frames.originalEyes[eye]);
  assert.ok(frames.disposed); assert.deepEqual(errors, []);
  assert.equal(frames.cachedLidFrames, 20);
  await mkdir('output/eyelid-brow-frames', {recursive:true});
  for(const frame of frames.snapshots)await writeFile(`output/eyelid-brow-frames/${String(frame.elapsed).padStart(3,'0')}.png`,Buffer.from(frame.png,'base64'));
  const report = { passed:true, checkedAt:new Date().toISOString(), actualProductionEyeAssets:true, cachedLidFrames:frames.cachedLidFrames, controlledClock:true, physicalMicrophone:false, cloudCalls:0, freshGpuInference:false, snapshots:frames.snapshots.length, maximumBrowDifference:frames.maximumBrowDifference, reopeningBrowDifference:frames.reopeningBrowDifference, originalOpenIrisesPreserved:true, bothEyesClose:true, maxIsolatedEyeDrawMs:frames.maxDrawMs, voiceIdPreserved:config.doubao.voiceId, pageErrors:errors };
  await writeFile(output,JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} catch(error) {
  await writeFile(output,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),error:error.message},null,2)); throw error;
} finally { await browser.close(); }
