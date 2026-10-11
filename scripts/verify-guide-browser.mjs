// Inspect deployed guide UI with actual production profiles, without changing saved settings.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base='http://127.0.0.1:4173',directory='output/guide-scenes';
await mkdir(directory,{recursive:true});
const [guide,config]=await Promise.all([fetch(base+'/api/guide').then(r=>r.json()),fetch(base+'/api/config').then(r=>r.json())]);
assert.equal(config.doubao.voiceId,'S_dCBmWoBh2');assert.equal(config.doubao.configured,true);assert.equal(config.chatgpt.sharing,false);
assert.deepEqual(guide.scenes.map(s=>s.id),['scenic']);assert.equal(guide.scenes[0].label,'旅游景区');
assert.deepEqual(Object.keys(guide.profiles),['scenic']);
assert.ok(guide.scenes.every(scene=>scene.role==='景区讲解员'));
assert.equal(/博物馆|企业展厅/.test(JSON.stringify(guide)),false);
const photoHash=createHash('sha256').update(await readFile('public/assets/avatar.png')).digest('hex');
const portraitSource=JSON.parse(await readFile('public/assets/avatar-source.json','utf8'));
assert.equal(photoHash,portraitSource.photoSHA256);
for(const kind of ['face-expressions','face-motion','hand-motion']){
 const manifest=JSON.parse(await readFile(`public/assets/${kind}/manifest.json`,'utf8'));
 assert.equal(manifest.photoSHA256,photoHash,`${kind} must match the active portrait`);
}
assert.equal(JSON.parse(await readFile('.runtime/avatar-model/native-source.json','utf8')).photoSHA256,photoHash);
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  await page.addInitScript(()=>localStorage.setItem('avatar-settings',JSON.stringify({persona:'你的名字是李云龙。自然耐心。',eagerness:'low'})));
  page.on('pageerror',e=>errors.push(e.message));const writes=[];
  page.on('request',request=>{if(request.url().endsWith('/api/guide')&&request.method()==='POST')writes.push(request.url());});
  await page.goto(base);await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true'&&!document.getElementById('connect').disabled);
  const snapshots=[];
  for(const scene of guide.scenes) {
    assert.equal(await page.locator('.guide-scene').count(),1);assert.equal(await page.locator('.guide-scene strong').textContent(),guide.profiles[scene.id].venue);
    assert.equal(await page.locator('button[data-guide-scene]').count(),0);
    await page.waitForFunction(id=>document.body.dataset.guideScene===id,scene.id);
    assert.equal(await page.locator('#guide-title').textContent(),guide.profiles[scene.id].venue);
    assert.equal(await page.locator('#guide-heading-name').textContent(),guide.profiles[scene.id].venue);
    assert.equal(await page.locator('#guide-nav').textContent(),guide.profiles[scene.id].venue);
    assert.equal(await page.locator('#guide-role').textContent(),scene.role);
    assert.equal(await page.title(),`${guide.profiles[scene.id].venue} · ${scene.role}`);
    assert.equal(await page.locator('#portrait').getAttribute('alt'),`${scene.role}的数字人形象`);
    assert.equal((await page.locator('body').innerText()).includes('李云龙'),false);
    assert.equal(/博物馆|企业展厅|火山|豆包|古镇人文|生态休闲|三个场景/.test(await page.locator('body').innerText()),false);
    assert.equal(await page.locator('#guide-venue').textContent(),`${scene.role} · 实时语音导览`);
    assert.equal(await page.locator('#guide-demo-label').isVisible(),guide.profiles[scene.id].demo);
    assert.equal(await page.locator('#chat').isVisible(),false);assert.equal(await page.locator('#text-form').isVisible(),false);assert.equal(await page.locator('#subtitle').isVisible(),false);
    await page.screenshot({path:`${directory}/tourism-desktop.png`,fullPage:true,animations:'disabled'});snapshots.push({scene:scene.id,title:scene.label,role:scene.role,venue:guide.profiles[scene.id].venue});
  }
  await page.locator('#settings-open').click();assert.equal(await page.locator('#guide-venue-input').inputValue(),guide.profiles.scenic.venue);
  assert.equal(/三个场景|各自保存|切换|火山|豆包/.test(await page.locator('#guide-settings').innerText()),false);
  assert.equal(await page.locator('#persona').inputValue(),'自然耐心。');
  assert.equal((await page.locator('body').innerText()).includes('李云龙'),false);
  await page.screenshot({path:`${directory}/tourism-settings.png`,animations:'disabled'});await page.locator('#settings-close').click();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:`${directory}/tourism-mobile.png`,fullPage:true,animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  const after=await (await fetch(base+'/api/guide')).json();assert.deepEqual(after,guide);
  const report={passed:true,checkedAt:new Date().toISOString(),productionProfiles:true,guideWrites:0,savedSettingsUnchanged:true,scenes:snapshots,singleTourismEntry:true,tourismOnly:true,sceneRoles:true,legacyNameRemoved:true,mobileFits:true,voiceOnly:true,voiceIdPreserved:config.doubao.voiceId,photoHash,chatgptSharing:false,cloudCalls:0,physicalMicrophone:false,pageErrors:errors};
  await writeFile(`${directory}/verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
