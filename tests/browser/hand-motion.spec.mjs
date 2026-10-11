import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function prepare(page, { invalid = false, delayed = false } = {}) {
  // The isolated renderer owns its canvas; disable the app-owned sibling here.
  await page.route('**/assets/hand-motion/manifest.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await page.waitForFunction(() => document.getElementById('portrait-layers').dataset.motionReady === 'true');
  const photoHash=createHash('sha256').update(await readFile('public/assets/avatar.png')).digest('hex');
  const manifest = { schema: 1, photoSHA256: photoHash, imageSize: [1145, 1374], region: [190, 1070, 700, 304], center: [545, 1235], radius: [305, 140], maxShift: [2.5, -4], maxTilt: .006 };
  if (invalid) manifest.photoSHA256 = '0'.repeat(64);
  await page.route('**/assets/hand-motion/manifest.json', async route => { if (delayed) await new Promise(resolve => setTimeout(resolve, 300)); await route.fulfill({ json: manifest }).catch(() => {}); });
  await page.evaluate(async () => {
    const { HandMotion } = await import('/hand-motion.js');
    window.hands = new HandMotion({ stage: document.getElementById('portrait-stage'), image: document.getElementById('portrait'), source: document.getElementById('local-mouth-canvas') });
  });
}

test('photo-local wrist movement keeps crop edges exact and changes hand pixels', async ({ page }) => {
  await prepare(page); expect(await page.evaluate(() => hands.load())).toBe(true);
  const result = await page.evaluate(() => {
    const read = () => { const bytes = new Uint8Array(hands.canvas.width * hands.canvas.height * 4); hands.gl.readPixels(0, 0, hands.canvas.width, hands.canvas.height, hands.gl.RGBA, hands.gl.UNSIGNED_BYTE, bytes); return bytes; };
    hands.draw(0); const before = read();
    const original = document.createElement('canvas'); original.width = 700; original.height = 304;
    const context = original.getContext('2d'); context.drawImage(hands.image, 190,1070,700,304,0,0,700,304);
    const photo = context.getImageData(0,0,700,304).data; let neutralError = 0;
    for(let y=0;y<304;y++)for(let x=0;x<700;x++)for(let c=0;c<3;c++)neutralError=Math.max(neutralError,Math.abs(before[(y*700+x)*4+c]-photo[((303-y)*700+x)*4+c]));
    hands.draw(1); const moved = read();
    let changed = 0, borderChanged = 0;
    for (let y = 0; y < 304; y++) for (let x = 0; x < 700; x++) {
      const at = (y * 700 + x) * 4;
      const diff = Math.max(...[0, 1, 2].map(c => Math.abs(before[at + c] - moved[at + c])));
      if (diff > 2) { changed++; if (x < 4 || y < 4 || x > 695 || y > 299) borderChanged++; }
    }
    hands.dispose(); return { changed, borderChanged, neutralError };
  });
  expect(result.changed).toBeGreaterThan(5000); expect(result.borderChanged).toBe(0); expect(result.neutralError).toBeLessThanOrEqual(1);
});

test('the production gesture visibly moves the clasped hands at normal page size', async ({ page }) => {
  await prepare(page);
  const spec = JSON.parse(await readFile('public/assets/hand-motion/manifest.json', 'utf8'));
  await page.route('**/assets/hand-motion/manifest.json', route => route.fulfill({ json: spec }));
  expect(await page.evaluate(() => hands.load())).toBe(true);
  const result = await page.evaluate(() => {
    const read = () => {
      const bytes = new Uint8Array(hands.canvas.width * hands.canvas.height * 4);
      hands.gl.readPixels(0,0,hands.canvas.width,hands.canvas.height,hands.gl.RGBA,hands.gl.UNSIGNED_BYTE,bytes);
      return bytes;
    };
    hands.draw(0); const before = read(); hands.draw(.85); const moved = read();
    const [cx,cy] = hands.spec.center.map((n,i) => n-hands.spec.region[i]);
    const width = hands.canvas.width, height = hands.canvas.height;
    const at = (x,y) => ((height-1-y)*width+x)*4;
    let best = { error: Infinity, dx: 0, dy: 0 };
    // Track original hand texture, rather than counting changed native pixels.
    for(let dy=-24;dy<=24;dy++)for(let dx=-20;dx<=20;dx++) {
      let error=0;
      for(let y=cy-28;y<=cy+28;y+=3)for(let x=cx-32;x<=cx+32;x+=3)
        for(let c=0;c<3;c++)error+=Math.abs(before[at(x,y)+c]-moved[at(x+dx,y+dy)+c]);
      if(error<best.error)best={error,dx,dy};
    }
    hands.canvas.hidden=false;
    const scale=hands.canvas.getBoundingClientRect().width/width;
    hands.dispose(); return { ...best, visiblePixels:Math.hypot(best.dx,best.dy)*scale };
  });
  expect(result.visiblePixels).toBeGreaterThan(3);
});

test('a quiet short reply triggers hands and brief frame gaps do not restart the gesture', async ({ page }) => {
  await prepare(page); expect(await page.evaluate(() => hands.load())).toBe(true);
  const result = await page.evaluate(() => {
    cancelAnimationFrame(hands.raf); window.requestAnimationFrame=()=>0;
    const source=document.getElementById('local-mouth-canvas');
    source.hidden=false; source.dataset.audioEnergy='.012'; hands.setState('responding'); hands.readActivity();
    hands.tick(1000); hands.tick(1400);
    const quietStrength=Number(hands.canvas.dataset.gestureStrength);
    source.dataset.audioEnergy='.12'; hands.readActivity(); hands.tick(1416); hands.tick(1650);
    const startBefore=hands.gestureStart;
    source.hidden=true; hands.readActivity(); const hiddenInGap=hands.canvas.hidden;
    source.hidden=false; hands.readActivity(); hands.tick(1700);
    const startAfter=hands.gestureStart, resumedStrength=Number(hands.canvas.dataset.gestureStrength);
    hands.setState('listening'); const hiddenOnStop=hands.canvas.hidden; hands.dispose();
    return { quietStrength,startBefore,startAfter,resumedStrength,hiddenInGap,hiddenOnStop };
  });
  expect(result.quietStrength).toBeGreaterThan(.3);
  expect(result.startAfter).toBe(result.startBefore);
  expect(result.resumedStrength).toBeGreaterThan(.4);
  expect(result.hiddenInGap).toBe(true); expect(result.hiddenOnStop).toBe(true);
});

test('hand gesture starts only with current audible speech and interruption restores the photograph', async ({ page }) => {
  await prepare(page); expect(await page.evaluate(() => hands.load())).toBe(true);
  await page.evaluate(() => { cancelAnimationFrame(hands.raf); window.requestAnimationFrame = () => 0; hands.setState('responding'); hands.tick(1000); });
  expect(await page.evaluate(() => hands.canvas.hidden)).toBe(true);
  const result = await page.evaluate(() => {
    const source = document.getElementById('local-mouth-canvas'); source.hidden = false; source.dataset.audioEnergy = '.12'; hands.readActivity();
    const strengths = []; for (let t = 1016; t <= 2800; t += 16) { hands.tick(t); strengths.push(Number(hands.canvas.dataset.gestureStrength || 0)); }
    const visible = !hands.canvas.hidden; source.hidden = true; hands.readActivity();
    return { strengths, visible, hiddenAfter: hands.canvas.hidden, strengthAfter: Number(hands.canvas.dataset.gestureStrength), rafAfter: hands.raf };
  });
  expect(result.visible).toBe(true); expect(Math.max(...result.strengths)).toBeGreaterThan(.5);
  expect(result.strengths.every((v, i, a) => !i || Math.abs(v - a[i - 1]) < .07)).toBe(true);
  expect(result.hiddenAfter).toBe(true); expect(result.strengthAfter).toBe(0); expect(result.rafAfter).toBe(0);
  await page.evaluate(() => hands.dispose());
});

test('held lip frames during silence settle the wrist before hiding and speech resumes without a snap', async ({ page }) => {
  await prepare(page); expect(await page.evaluate(() => hands.load())).toBe(true);
  const result=await page.evaluate(()=>{
    cancelAnimationFrame(hands.raf); window.requestAnimationFrame=()=>0;
    const source=document.getElementById('local-mouth-canvas');
    source.hidden=false; source.dataset.audioEnergy='.12'; hands.setState('responding'); hands.readActivity();
    for(let time=1000;time<=1496;time+=16)hands.tick(time);
    const before=Number(hands.canvas.dataset.gestureStrength);
    source.dataset.audioEnergy='0'; hands.readActivity();
    const release=[];
    for(let time=1512;time<=1608;time+=16){hands.tick(time);release.push(Number(hands.canvas.dataset.gestureStrength));}
    const settled=hands.canvas.hidden;
    source.dataset.audioEnergy='.12'; hands.readActivity();
    hands.tick(1624); const first=Number(hands.canvas.dataset.gestureStrength);
    const recovery=[];
    for(let time=1640;time<=1752;time+=16){hands.tick(time);recovery.push(Number(hands.canvas.dataset.gestureStrength));}
    source.hidden=true; hands.readActivity();
    const interrupted=hands.canvas.hidden && hands.canvas.dataset.gestureStrength==='0';
    hands.dispose(); return {before,release,settled,first,recovery,interrupted};
  });
  expect(result.before).toBeGreaterThan(.4);
  expect(result.release[0]).toBeGreaterThan(result.before*.8);
  expect(result.release.every((v,i,a)=>!i||v<=a[i-1])).toBe(true);
  expect(result.release.at(-1)).toBe(0); expect(result.settled).toBe(true);
  expect(result.first).toBeLessThan(.18); expect(result.recovery.at(-1)).toBeGreaterThan(.4);
  expect(result.interrupted).toBe(true);
});

test('motion switch, reduced motion and page suspension stop hands and resume on current speech', async ({ page }) => {
  await prepare(page); expect(await page.evaluate(() => hands.load())).toBe(true);
  await page.evaluate(() => { const source = document.getElementById('local-mouth-canvas'); source.hidden = false; source.dataset.audioEnergy = '.12'; hands.setState('responding'); hands.readActivity(); });
  await expect.poll(() => page.evaluate(() => !hands.canvas.hidden)).toBe(true);
  await page.evaluate(() => hands.setEnabled(false)); expect(await page.evaluate(() => hands.canvas.hidden)).toBe(true);
  await page.evaluate(() => hands.setEnabled(true)); await expect.poll(() => page.evaluate(() => !hands.canvas.hidden)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect.poll(() => page.evaluate(() => hands.canvas.hidden)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => hands.setSuspended(true)); expect(await page.evaluate(() => hands.canvas.hidden)).toBe(true);
  await page.evaluate(() => hands.setSuspended(false)); await expect.poll(() => page.evaluate(() => !hands.canvas.hidden)).toBe(true);
  await page.evaluate(() => hands.dispose()); expect(await page.locator('canvas.hand-motion').count()).toBe(0);
});

test('wrong portrait and disposal during loading do not enable hand animation', async ({ page }) => {
  await prepare(page, { invalid: true }); expect(await page.evaluate(() => hands.load())).toBe(false);
  expect(await page.locator('canvas.hand-motion').count()).toBe(0); await page.evaluate(() => hands.dispose());
  await prepare(page, { delayed: true }); const loading = page.evaluate(() => hands.load());
  await page.waitForTimeout(30); await page.evaluate(() => hands.dispose()); expect(await loading).toBe(false);
  expect(await page.locator('canvas.hand-motion').count()).toBe(0);
});

test('the complete portrait and hands fit the conversation view and fullscreen', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => document.getElementById('portrait-layers').dataset.motionReady === 'true');
  const fit = () => page.evaluate(() => {
    const stage = document.getElementById('portrait-stage').getBoundingClientRect(), image = document.getElementById('portrait').getBoundingClientRect();
    return { left: image.left - stage.left, top: image.top - stage.top, right: image.right - stage.right, bottom: image.bottom - stage.bottom };
  });
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(80); const r = await fit();
    expect(r.left).toBeGreaterThanOrEqual(-1); expect(r.top).toBeGreaterThanOrEqual(-1); expect(r.right).toBeLessThanOrEqual(1); expect(r.bottom).toBeLessThanOrEqual(1);
  }
  await page.locator('#fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement); const r = await fit();
  expect(r.top).toBeGreaterThanOrEqual(-1); expect(r.bottom).toBeLessThanOrEqual(1); await page.evaluate(() => document.exitFullscreen());
});

test('the voice status and decorative labels do not cover the hands', async ({ page }) => {
  await page.goto('/');
  for(const viewport of [{width:1440,height:1100},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await expect.poll(()=>page.evaluate(()=>{
      const image=document.getElementById('portrait'),r=image.getBoundingClientRect();
      const scale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);
      const left=r.left+(r.width-image.naturalWidth*scale)/2+190*scale;
      const top=r.top+(r.height-image.naturalHeight*scale)/2+1070*scale;
      const right=left+700*scale,bottom=top+304*scale;
      return [...document.querySelectorAll('.avatar-live,.avatar-bottom p')].every(element=>{
        const box=element.getBoundingClientRect();return box.width===0||box.height===0||box.right<=left||box.left>=right||box.bottom<=top||box.top>=bottom;
      });
    })).toBe(true);
  }
});

test('the conversation page drives hands from played mouth frames and stops them on interruption', async ({ page }) => {
  await page.route('/api/config', route => route.fulfill({ json: { apiConfigured: false, chatgpt: { sharing: false }, doubao: { selected: true, configured: true, voice: 'uploaded-reference', voiceId: 'S_dCBmWoBh2' }, simli: { enabled: false }, localAvatar: { enabled: true } } }));
  let voice, lips;
  await page.routeWebSocket('**/api/doubao/live', ws => { voice = ws; ws.onMessage(data => { if(typeof data === 'string' && JSON.parse(data).type === 'start') ws.send(JSON.stringify({ type: 'ready', voice: 'uploaded-reference', sampleRate: 24000 })); }); });
  await page.routeWebSocket('**/api/avatar/live', ws => { lips = ws; ws.send(JSON.stringify({ type: 'ready', fps: 20, sampleRate: 24000, imageSize: [1145,1374], region: [391,476,336,151] })); });
  await page.goto('/'); await page.waitForFunction(() => document.querySelector('.hand-motion')?.dataset.ready === 'true');
  await page.locator('#connect').click(); await expect(page.locator('#connection-summary')).toHaveText('语音对话已连接'); await page.locator('#mute').click();
  voice.send(JSON.stringify({ type: 'response_started', replyId: 'hands-page', questionId: 'question' }));
  const audio = Buffer.alloc(2400); for(let n=0;n<1200;n++)audio.writeInt16LE(Math.round(5000*Math.sin(n*2*Math.PI*240/24000)),n*2);
  const jpeg = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAK0lEQVQIHW3BAQEAAADBMCrJ9LBiKWBziR6X6HGJHpfocYkel+hxiR6X6BnB0Ar5y9fgkgAAAABJRU5ErkJggg==';
  for(let index=0;index<60;index++)lips.send(JSON.stringify({type:'frame',replyId:'hands-page',index,pcm:audio.toString('base64'),jpeg}));
  await expect(page.locator('.hand-motion')).toBeVisible(); await expect.poll(() => page.locator('.hand-motion').evaluate(c => Number(c.dataset.gestureStrength))).toBeGreaterThan(.3);
  await expect(page.locator('#subtitle')).toBeHidden(); await expect(page.locator('#chat')).toBeHidden();
  await page.locator('#interrupt').click(); await expect(page.locator('.hand-motion')).toBeHidden(); await expect(page.locator('#local-mouth-canvas')).toBeHidden();
  expect(await page.locator('.hand-motion').evaluate(c => Number(c.dataset.gestureStrength))).toBe(0);
  await page.locator('#connect').click();
});
