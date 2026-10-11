// Production hand renderer at actual page scale. No live microphone, cloud or GPU model lease.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
const directory='output/hand-motion-visibility';
await mkdir(directory,{recursive:true});
const spec=JSON.parse(await readFile('public/assets/hand-motion/manifest.json','utf8'));
const config=await (await fetch('http://127.0.0.1:4173/api/config')).json();
assert.equal(config.doubao.voiceId,'S_dCBmWoBh2');
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/assets/hand-motion/manifest.json',r=>r.fulfill({status:404,body:''}));
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true');
  await page.locator('#motion-toggle').click();
  await page.route('**/assets/hand-motion/manifest.json',r=>r.fulfill({json:spec}));
  await page.evaluate(async()=>{
    const {HandMotion}=await import('/hand-motion.js');
    window.hands=new HandMotion({stage:document.getElementById('portrait-stage'),image:document.getElementById('portrait'),source:document.getElementById('local-mouth-canvas')});
    if(!await hands.load())throw Error('Hands unavailable');
    hands.schedule=()=>{}; hands.source.hidden=false;hands.source.dataset.audioEnergy='.012';hands.setState('responding');hands.readActivity();hands.tick(1000);
  });
  const geometry=await page.evaluate(()=>{
    hands.canvas.hidden=false;const r=hands.canvas.getBoundingClientRect();hands.canvas.hidden=true;
    return {x:r.x,y:r.y,width:r.width,height:r.height,scale:r.width/hands.canvas.width};
  });
  const snapshots=[];
  for(const elapsed of [0,150,300,450,650,850,1100,1400,1700,1900]) {
    const result=await page.evaluate(elapsed=>{hands.tick(1000+elapsed);return {strength:Number(hands.canvas.dataset.gestureStrength),visible:!hands.canvas.hidden};},elapsed);
    await page.screenshot({path:`${directory}/${elapsed}.png`}); snapshots.push({elapsed,...result});
  }
  const stopped=await page.evaluate(()=>{hands.setState('listening');const hidden=hands.canvas.hidden;hands.dispose();return hidden&&document.querySelectorAll('.hand-motion').length===0;});
  assert.ok(snapshots.some(n=>n.strength>.8&&n.visible));assert.equal(stopped,true);assert.deepEqual(errors,[]);
  const report={passed:true,checkedAt:new Date().toISOString(),actualProductionAssets:true,quietSpeechRms:.012,geometry,snapshots,stopsAtEnd:true,disposed:true,voiceIdPreserved:config.doubao.voiceId,cloudCalls:0,physicalMicrophone:false,freshNeuralInference:false,pageErrors:errors};
  await writeFile(`${directory}/verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
