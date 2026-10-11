import { test, expect, chromium } from '@playwright/test';

async function prepare(page, invalid = false, cropped = false, compact = false) {
  await page.goto('/');
  await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true');
  const fixture = await page.evaluate(async ({cropped,compact}) => {
    const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d');ctx.fillStyle='#354d62';ctx.fillRect(0,0,64,64);
    if(cropped){for(let x=0;x<64;x+=8){ctx.fillStyle=x%16?'#dca660':'#354d62';ctx.fillRect(x,0,8,8);}}
    const photo=c.toDataURL('image/png');
    const digest=async url=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch(url)).arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const photoHash=await digest(photo);
    ctx.fillStyle='rgb(128,128,128)';ctx.fillRect(0,0,64,64);ctx.fillStyle='rgb(204,128,128)';ctx.fillRect(cropped?0:8,cropped?0:8,cropped?64:48,cropped?64:48);
    const field=()=>{if(!compact)return c.toDataURL('image/png');const tile=document.createElement('canvas');tile.width=tile.height=48;tile.getContext('2d').drawImage(c,8,8,48,48,0,0,48,48);return tile.toDataURL('image/png');};
    const pitch=field();const pitchHash=await digest(pitch);
    ctx.fillStyle='rgb(128,128,128)';ctx.fillRect(0,0,64,64);const yaw=field();const yawHash=await digest(yaw);
    const stage=document.createElement('div');stage.id='coherent-stage';stage.style.cssText='position:fixed;left:0;top:0;width:512px;height:512px;z-index:99;';
    const root=document.createElement('div');root.id='coherent-test';root.style.cssText='position:absolute;inset:0;';stage.append(root);
    const image=new Image();image.src=photo;image.style.cssText='position:absolute;inset:0;width:100%;height:100%;';root.append(image);
    for(const [name,color,y]of[['eye','#ff0000',18],['mouth','#00ff00',38]]){const layer=document.createElement('canvas');layer.id='coherent-'+name;layer.width=layer.height=64;layer.style.cssText='position:absolute;inset:0;width:100%;height:100%;';layer.getContext('2d').fillStyle=color;layer.getContext('2d').fillRect(20,y,8,6);root.append(layer);}
    document.body.append(stage);window.requestAnimationFrame=()=>0;
    return {photoHash,pitch,pitchHash,yaw,yawHash};
  },{cropped,compact});
  await page.route('**/assets/face-motion/manifest.json', route=>route.fulfill({json:{schema:1,photoSHA256:fixture.photoHash,imageSize:[64,64],region:cropped?[8,8,48,48]:undefined,fieldSize:compact?[48,48]:undefined,scale:.02,fields:{pitch:'pitch-field.png',yaw:'yaw-field.png'},fieldSHA256:{pitch:invalid?'0'.repeat(64):fixture.pitchHash,yaw:fixture.yawHash}}}));
  await page.route('**/assets/face-motion/*-field.png', route=>route.fulfill({contentType:'image/png',body:Buffer.from((route.request().url().includes('pitch')?fixture.pitch:fixture.yaw).split(',')[1],'base64')}));
  await page.evaluate(async()=>{
    const {FaceMotion}=await import('/face-motion.js');
    window.coherent=new FaceMotion({element:document.getElementById('coherent-test'),stage:document.getElementById('coherent-stage'),image:document.querySelector('#coherent-test img'),source:document.getElementById('coherent-mouth'),onActivity:level=>window.coherentActivity=level});
  });
  return fixture;
}
async function pixels(page) {
  const png=await page.locator('#coherent-test').screenshot();
  return page.evaluate(async bytes=>{
    const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);image.close();
    const values=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const sums={eye:[0,0,0],mouth:[0,0,0]};for(let at=0;at<values.length;at+=4){let key;if(values[at]>240&&values[at+1]<20&&values[at+2]<20)key='eye';if(values[at+1]>240&&values[at]<20&&values[at+2]<20)key='mouth';if(key){sums[key][0]+=(at/4)%c.width;sums[key][1]+=Math.floor(at/4/c.width);sums[key][2]++;}}
    return {eye:sums.eye.slice(0,2).map(n=>n/sums.eye[2]),mouth:sums.mouth.slice(0,2).map(n=>n/sums.mouth[2]),border:Array.from(values.slice(0,8*c.width*4))};
  },Array.from(png));
}

test('one geometry moves eyes and lips together while leaving the scene border fixed',async({page})=>{
  await prepare(page);expect(await page.evaluate(()=>coherent.load())).toBe(true);
  await page.evaluate(()=>coherent.render(0,0));const still=await pixels(page);
  await page.evaluate(()=>coherent.render(1,0));const moved=await pixels(page);
  const eyeShift=moved.eye[0]-still.eye[0],mouthShift=moved.mouth[0]-still.mouth[0];
  expect(Math.abs(eyeShift)).toBeGreaterThan(1.5);expect(Math.abs(eyeShift-mouthShift)).toBeLessThan(.5);expect(moved.border).toEqual(still.border);
  await page.evaluate(()=>coherent.setEnabled(false));const stopped=await pixels(page);expect(stopped.eye).toEqual(still.eye);expect(stopped.mouth).toEqual(still.mouth);
  await page.evaluate(()=>coherent.dispose());
});

test('wrong motion assets leave the portrait untouched and disposal prevents late activity',async({page})=>{
  await prepare(page,true);expect(await page.evaluate(()=>coherent.load())).toBe(false);
  expect(await page.locator('#coherent-test').evaluate(el=>el.style.filter)).toBe('');
  await page.evaluate(()=>{coherent.dispose();const c=document.getElementById('coherent-mouth');c.dataset.audioEnergy='.2';});
  expect(await page.evaluate(()=>window.coherentActivity||0)).toBe(0);
});

test('unchanged or invisible head movement does not repeatedly invalidate the GPU filter',async({page})=>{
  await prepare(page);expect(await page.evaluate(()=>coherent.load())).toBe(true);
  const result=await page.evaluate(async()=>{
    cancelAnimationFrame(coherent.raf);coherent.raf=0;window.requestAnimationFrame=()=>0;
    const writes=[];const observer=new MutationObserver(records=>writes.push(...records));
    for(const map of Object.values(coherent.maps))observer.observe(map,{attributes:true,attributeFilter:['scale']});
    observer.observe(coherent.element,{attributes:true,attributeFilter:['style']});
    for(let i=0;i<12;i++)coherent.render(.25+i*.00001,-.12-i*.00001);
    await Promise.resolve();observer.disconnect();const first=writes.length;
    const p=Number(coherent.element.dataset.pitch),y=Number(coherent.element.dataset.yaw);
    coherent.render(.5,-.25);const moved=Number(coherent.element.dataset.pitch)>.4;
    coherent.dispose();return {writes:first,p,y,moved};
  });
  expect(result.writes).toBeLessThanOrEqual(3);expect(Math.abs(result.p-.25)).toBeLessThan(.0025);expect(Math.abs(result.y+.12)).toBeLessThan(.0025);expect(result.moved).toBe(true);
});

test('a held mouth picture without sound does not trigger a speaking head posture',async({page})=>{
  await prepare(page); expect(await page.evaluate(()=>coherent.load())).toBe(true);
  const result=await page.evaluate(()=>{
    window.requestAnimationFrame=()=>0;
    const random=Math.random; Math.random=()=>.99;
    const source=coherent.source; source.hidden=false; source.dataset.audioEnergy='0';
    coherent.setState('responding'); coherent.readActivity(); coherent.tick(1000);
    const quiet=coherent.posture[0];
    source.dataset.audioEnergy='.12'; coherent.readActivity(); coherent.nextPosture=0; coherent.tick(1016);
    const audible=coherent.posture[0]; Math.random=random; coherent.dispose();
    return {quiet,audible};
  });
  expect(Math.abs(result.quiet)).toBeLessThan(.04);
  expect(result.audible).toBeGreaterThan(.2);
});

test('listening nods gently without requiring output audio', async ({page}) => {
  await prepare(page); expect(await page.evaluate(() => coherent.load())).toBe(true);
  const result = await page.evaluate(() => {
    document.getElementById('coherent-mouth').hidden = true;
    coherent.posture = [0,0]; coherent.nextPosture = 10000; coherent.pitch = coherent.yaw = 0;
    coherent.setState('listening'); coherent.nextPosture = 10000;
    const values=[]; for(let t=1000;t<=3000;t+=16){coherent.tick(t);values.push(Number(coherent.element.dataset.pitch));}
    coherent.dispose(); return {peak:Math.max(...values),tail:values.at(-1)};
  });
  expect(result.peak).toBeGreaterThan(.1); expect(result.tail).toBeLessThan(.03);
});

test('cropped head movement retains the original backdrop outside the changed region',async({page})=>{
  await prepare(page,false,true,true);expect(await page.evaluate(()=>coherent.load())).toBe(true);
  await page.evaluate(()=>coherent.render(0,0));const still=await pixels(page);
  await page.evaluate(()=>coherent.render(1,0));const moved=await pixels(page);
  expect(Math.abs(moved.eye[0]-still.eye[0])).toBeGreaterThan(1.5);
  expect(moved.border).toEqual(still.border);
  await page.evaluate(()=>coherent.dispose());
  expect(await page.locator('#coherent-test').evaluate(element=>element.style.filter)).toBe('');
});

test('portrait and static backing keep the same photo geometry in tall fullscreen',async({page})=>{
  await page.setViewportSize({width:600,height:1200});await page.goto('/');
  await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true');
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);
  const photos=await page.evaluate(()=>{
    const geometry=image=>{const r=image.getBoundingClientRect(),style=getComputedStyle(image);const scale=(style.objectFit==='contain'?Math.min:Math.max)(r.width/image.naturalWidth,r.height/image.naturalHeight);const w=image.naturalWidth*scale,h=image.naturalHeight*scale;const p=style.objectPosition.split(' ').map(v=>parseFloat(v)/100);return [r.left+(r.width-w)*p[0],r.top+(r.height-h)*p[1],w,h];};
    return [geometry(document.getElementById('portrait')),geometry(document.querySelector('.face-motion-backing'))];
  });
  for(let i=0;i<4;i++)expect(Math.abs(photos[0][i]-photos[1][i])).toBeLessThan(1);
  await page.evaluate(()=>document.exitFullscreen());
});

test('motion preference and hidden pages pause the shared geometry and current voice activity',async({page})=>{
  await prepare(page);expect(await page.evaluate(()=>coherent.load())).toBe(true);
  await page.evaluate(()=>{coherent.setState('responding');document.getElementById('coherent-mouth').dataset.audioEnergy='.2';coherent.tick(1000);});
  await expect.poll(()=>page.evaluate(()=>coherentActivity)).toBe(1);
  await page.emulateMedia({reducedMotion:'reduce'});
  // Chrome delivers the media-query change after the emulation command returns.
  await expect.poll(()=>page.locator('#coherent-test').evaluate(el=>el.style.filter)).toBe('');
  await expect.poll(()=>page.evaluate(()=>coherentActivity)).toBe(0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  expect(await page.locator('#coherent-test').evaluate(el=>el.style.filter)).toBe('');
  expect(await page.evaluate(()=>!!coherent.raf)).toBe(false);
  await page.evaluate(()=>coherent.dispose());
});

test('closing during a delayed field load revokes acquired URLs and cannot restore geometry',async({page})=>{
  const fixture=await prepare(page);
  await page.route('**/assets/face-motion/yaw-field.png',async route=>{await new Promise(resolve=>setTimeout(resolve,400));await route.fulfill({contentType:'image/png',body:Buffer.from(fixture.yaw.split(',')[1],'base64')}).catch(()=>{});});
  await page.evaluate(()=>{window.motionUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);motionUrls.add(url);return url;};URL.revokeObjectURL=url=>{motionUrls.delete(url);revoke(url);};});
  const loading=page.evaluate(()=>coherent.load());
  await expect.poll(()=>page.evaluate(()=>motionUrls.size)).toBeGreaterThan(0);
  await page.evaluate(()=>coherent.dispose());expect(await loading).toBe(false);
  expect(await page.evaluate(()=>motionUrls.size)).toBe(0);
  expect(await page.locator('#coherent-test').evaluate(el=>el.style.filter)).toBe('');
});

test('returning through Chrome page cache restores coordinated movement and blinking',async({baseURL})=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',ignoreDefaultArgs:['--disable-back-forward-cache']});
  try {
    const page=await browser.newPage({baseURL});
    await page.addInitScript(()=>{window.pageCacheEvents=[];window.addEventListener('pageshow',event=>pageCacheEvents.push(event.persisted));});
    await page.goto('/');
    await page.waitForFunction(()=>document.getElementById('portrait-layers').dataset.motionReady==='true');
    await page.waitForFunction(()=>document.getElementById('face-expression-canvas').dataset.ready==='true');
    await page.goto('/assets/face-motion/pitch-field.png');
    await page.goBack({waitUntil:'commit'});
    // A navigation commit can precede pageshow; require a real cache restoration once it fires.
    await expect.poll(()=>page.evaluate(()=>pageCacheEvents.includes(true))).toBe(true);
    expect(await page.locator('#portrait-stage').evaluate(stage=>stage.classList.contains('coherent-face'))).toBe(true);
    await expect.poll(()=>page.locator('#portrait-layers').evaluate(element=>element.style.filter)).toMatch(/^url\(/);
    await page.waitForFunction(()=>{const eyes=document.getElementById('face-expression-canvas');return !eyes.hidden&&eyes.dataset.pose?.startsWith('blink');},null,{timeout:7500});
  } finally {await browser.close();}
});
