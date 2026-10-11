import { test, expect } from '@playwright/test';

async function prepare(page, options = {}) {
  await page.goto('/');
  const fixture = await page.evaluate(async distinct => {
    const photo = await (await fetch('/assets/avatar.png')).arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', photo))].map(n => n.toString(16).padStart(2, '0')).join('');
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    canvas.getContext('2d').fillStyle = '#bc6854'; canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const poseHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const variants = {};
    if (distinct) {
      for (const [name, red] of Object.entries({ neutral: 0, blink25: 80, blink50: 140, blink75: 200, blink100: 240, attentive: 30, 'gaze-left': 30, 'gaze-right': 30, 'blink-frame-01': 170, 'blink-frame-02': 240 })) {
        const context = canvas.getContext('2d'); context.fillStyle = `rgb(${red},0,0)`; context.fillRect(0, 0, 8, 8);
        const png = canvas.toDataURL('image/png').split(',')[1];
        const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        variants[name] = { png, hash };
      }
    }
    return { hash, png, poseHash, variants };
  }, options.distinct === true);
  const poses = Object.fromEntries(['neutral', 'blink25', 'blink50', 'blink75', 'blink100', 'attentive', 'gaze-left', 'gaze-right'].map(name => [name, name + '.png']));
  const blinkSequence = options.sequence ? ['blink-frame-01', 'blink-frame-02'] : undefined;
  for(const name of blinkSequence || [])poses[name]=name+'.png';
  const poseSHA256 = Object.fromEntries(Object.keys(poses).map(name => [name, options.corruptPose ? '0'.repeat(64) : fixture.variants[name]?.hash || fixture.poseHash]));
  const eyeMasks = options.badMask ? [{ center: [422, 340], radius: [2, 2], feather: .2 }] : [{ center: [422, 355], radius: [2, 2], feather: .2 }, { center: [426, 355], radius: [2, 2], feather: .2 }];
  await page.route('**/assets/face-expressions/manifest.json', route => route.fulfill({ json: { schema: 1, photoSHA256: options.badHash ? '0'.repeat(64) : fixture.hash, imageSize: [1145, 1374], region: [420, 350, 8, 8], eyeMasks, blinkSequence:options.badSequence ? [] : blinkSequence, poses, poseSHA256 } }));
  await page.route('**/assets/face-expressions/*.png', async route => {
    if (options.delay || (options.delayOne && route.request().url().endsWith('attentive.png'))) await new Promise(resolve => setTimeout(resolve, 350));
    const name = route.request().url().split('/').at(-1).replace('.png', '');
    await route.fulfill({ status: options.broken ? 404 : 200, contentType: 'image/png', body: Buffer.from(fixture.variants[name]?.png || fixture.png, 'base64') });
  });
  await page.evaluate(async () => {
    const { FaceExpression } = await import('/face-expression.js');
    const canvas = document.createElement('canvas'); canvas.id = 'expression-test'; document.getElementById('portrait-stage').append(canvas);
    window.face = new FaceExpression({ canvas, image: document.getElementById('portrait') });
  });
}

test('blink renders continuous intermediate frames without a closed-eye pause and returns to the current eye expression', async ({ page }) => {
  await prepare(page, { distinct: true });
  expect(await page.evaluate(() => face.load())).toBe(true);
  const result = await page.evaluate(() => {
    // Drive the real renderer with a controlled animation clock and distinct pose pixels.
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); face.raf = 0; face.timer = 0;
    window.requestAnimationFrame = () => 0;
    face.state = 'listening'; face.intensity = .7; face.target = .7;
    const visible = document.createElement('canvas'); visible.width = 1; visible.height = 1;
    const pixel = () => { const c = visible.getContext('2d'); c.drawImage(face.image, 422, 355, 1, 1, 0, 0, 1, 1); c.drawImage(face.canvas, 422, 355, 1, 1, 0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data[0]; };
    face.tick(1000); const before = pixel(); face.blinkStart = 1000;
    const frames = [];
    for (let elapsed = 0; elapsed <= 300; elapsed += 5) { face.tick(1000 + elapsed); frames.push({ elapsed, red: pixel() }); }
    const mouthAlpha = face.context.getImageData(550, 550, 1, 1).data[3];
    face.dispose(); return { before, frames, mouthAlpha };
  });
  const moving = result.frames.filter(frame => frame.elapsed > 0 && frame.elapsed < 220);
  expect(new Set(moving.map(frame => frame.red)).size).toBeGreaterThan(15);
  const closed = result.frames.filter(frame => frame.red >= 239);
  expect(closed.length).toBeGreaterThan(0);
  expect(closed.at(-1).elapsed - closed[0].elapsed).toBeLessThanOrEqual(30);
  expect(result.frames[0].red).toBe(result.before);
  expect(result.frames.at(-1).red).toBe(result.before);
  expect(result.mouthAlpha).toBe(0);
});

test('closing either eyelid never replaces the current eyebrows or pixels outside the eyelid masks', async ({ page }) => {
  await prepare(page, { distinct: true });
  expect(await page.evaluate(() => face.load())).toBe(true);
  const result = await page.evaluate(() => {
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); face.raf = 0; face.timer = 0;
    window.requestAnimationFrame = () => 0;
    face.state = 'listening'; face.intensity = .7; face.target = .7;
    const sample = () => ({ brow: [...face.context.getImageData(421, 351, 1, 1).data], eyes: [422, 426].map(x => [...face.context.getImageData(x, 355, 1, 1).data]) });
    face.tick(1000); const before = sample(); face.blinkStart = 1000;
    const frames = [];
    for (const elapsed of [0, 20, 40, 60, 70, 85, 110, 140, 180, 210, 220]) { face.tick(1000 + elapsed); frames.push(sample()); }
    face.dispose(); return { before, frames };
  });
  for (const frame of result.frames) expect(frame.brow).toEqual(result.before.brow);
  for (const eye of [0, 1]) {
    expect(result.frames[4].eyes[eye][0]).toBe(240);
    expect(result.frames[4].eyes[eye][3]).toBe(255);
    expect(result.frames.at(-1).eyes[eye]).toEqual(result.before.eyes[eye]);
  }
});

test('cached lid trajectories are actually used instead of dissolving the four coarse poses', async ({ page }) => {
  await prepare(page, { distinct:true, sequence:true });
  expect(await page.evaluate(()=>face.load())).toBe(true);
  const result = await page.evaluate(()=>{
    cancelAnimationFrame(face.raf);clearTimeout(face.timer);face.raf=0;face.timer=0;window.requestAnimationFrame=()=>0;
    face.state='listening';face.intensity=face.target=.7;face.blinkStart=1000;
    face.tick(1035);const middle=[...face.context.getImageData(422,355,1,1).data];
    face.tick(1070);const closed=[...face.context.getImageData(422,355,1,1).data];
    face.dispose();return {middle,closed};
  });
  expect(result.middle).toEqual([170,0,0,255]);expect(result.closed).toEqual([240,0,0,255]);
});

test('the real portrait keeps its original open irises and continuous source-textured brows throughout a blink', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { FaceExpression } = await import('/face-expression.js');
    const image = document.getElementById('portrait'), canvas = document.createElement('canvas');
    const face = new FaceExpression({ image, canvas });
    if (!await face.load()) throw new Error('Actual photo-bound assets unavailable');
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); face.raf = 0; face.timer = 0;
    window.requestAnimationFrame = () => 0;
    face.state = 'listening'; face.intensity = .7; face.target = .7;
    const scene = document.createElement('canvas'); scene.width = canvas.width; scene.height = canvas.height;
    const c = scene.getContext('2d');
    c.drawImage(image, 0, 0);
    const points = [[488, 408], [619, 399]], original = points.map(([x,y]) => [...c.getImageData(x,y,1,1).data]);
    face.tick(1000); c.drawImage(canvas, 0, 0);
    const attentive = points.map(([x,y]) => [...c.getImageData(x,y,1,1).data]);
    const browPixels = () => {
      c.drawImage(image, 0, 0); c.drawImage(canvas, 0, 0);
      return [c.getImageData(441,344,96,37).data, c.getImageData(574,341,91,34).data].map(data => [...data]);
    };
    const before = browPixels(); face.blinkStart = 1000; const browDifferences = [];
    let closed;
    for(let elapsed=0;elapsed<=220;elapsed+=5) {
      face.tick(1000+elapsed);
      const current=browPixels(); browDifferences.push(Math.max(...current.flatMap((data,k)=>data.map((value,i)=>Math.abs(value-before[k][i])))));
      if(elapsed===70) { c.drawImage(image,0,0); c.drawImage(canvas,0,0); closed=points.map(([x,y])=>[...c.getImageData(x,y,1,1).data]); }
    }
    face.dispose(); return {original,attentive,closed,browDifferences};
  });
  expect(result.attentive).toEqual(result.original);
  expect(Math.max(...result.browDifferences)).toBeLessThanOrEqual(1);
  for(let eye=0;eye<2;eye++)expect(result.closed[eye]).not.toEqual(result.original[eye]);
});

test('speaking brow emphasis follows current sound instead of holding one expression', async ({ page }) => {
  await prepare(page, { distinct: true });
  expect(await page.evaluate(() => face.load())).toBe(true);
  const levels = await page.evaluate(() => {
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); face.raf=0; face.timer=0; window.requestAnimationFrame=()=>0;
    face.setState('responding'); face.setSpeech(0);
    for(let time=1000;time<1800;time+=20)face.tick(time);
    const quiet=face.context.getImageData(421,351,1,1).data[3];
    face.setSpeech(1);
    for(let time=1800;time<2600;time+=20)face.tick(time);
    const speaking=face.context.getImageData(421,351,1,1).data[3];
    face.setState('listening'); face.setSpeech(0);
    for(let time=2600;time<3400;time+=20)face.tick(time);
    const listening=face.context.getImageData(421,351,1,1).data[3];
    face.dispose(); return {quiet,speaking,listening};
  });
  expect(levels.speaking-levels.quiet).toBeGreaterThan(30);
  expect(levels.listening).toBeGreaterThan(levels.speaking);
});

test('eye gaze eases into thought and returns continuously when the reply starts', async ({ page }) => {
  await prepare(page, { distinct: true });
  expect(await page.evaluate(() => face.load())).toBe(true);
  const result = await page.evaluate(async () => {
    cancelAnimationFrame(face.raf); clearTimeout(face.timer); window.requestAnimationFrame=()=>0;
    face.intensity=face.target=1;
    const sample=()=>face.context.getImageData(422,355,1,1).data[3];
    // Isolate gaze from brow emphasis using a transparent attentive pose.
    const empty=document.createElement('canvas'); empty.width=empty.height=8;
    face.bitmaps.get('attentive').close(); face.bitmaps.set('attentive',await createImageBitmap(empty));
    face.tick(4000); const neutral=sample();
    face.setState('thinking'); face.tick(4016); const entry=sample();
    for(let time=4032;time<=5504;time+=16)face.tick(time);
    const looking=sample(); face.setState('responding');
    const returning=[];
    for(let time=5520;time<=6512;time+=16){face.tick(time);returning.push(sample());}
    face.dispose(); return {neutral,entry,looking,returning};
  });
  expect(Math.abs(result.entry-result.neutral)).toBeLessThanOrEqual(3);
  expect(result.looking).toBeGreaterThan(15);
  expect(result.returning[0]).toBeGreaterThan(result.looking*.7);
  expect(result.returning.every((v,i,a)=>Math.abs(v-(i?a[i-1]:result.looking))<=6)).toBe(true);
  expect(result.returning.at(-1)).toBeLessThanOrEqual(2);
});

test('learned blinking and attentive expression touch upper face only; motion and visibility pause animation', async ({ page }) => {
  await prepare(page);
  expect(await page.evaluate(() => face.load())).toBe(true);
  await page.evaluate(() => { face.setState('listening'); face.blink(); });
  await expect(page.locator('#expression-test')).toBeVisible();
  await expect.poll(() => page.evaluate(() => face.canvas.dataset.pose)).toMatch(/blink/);
  const pixels = await page.evaluate(() => {
    const c = face.canvas.getContext('2d'); return { eye: c.getImageData(422, 355, 1, 1).data[3], mouth: c.getImageData(550, 550, 1, 1).data[3] };
  });
  expect(pixels.eye).toBeGreaterThan(0); expect(pixels.mouth).toBe(0);
  await page.waitForTimeout(380);
  expect(await page.evaluate(() => face.canvas.dataset.pose)).toBe('attentive');
  await page.evaluate(() => face.setEnabled(false));
  await expect(page.locator('#expression-test')).toBeHidden();
  expect(await page.evaluate(() => !!face.raf || !!face.timer)).toBe(false);
  await page.evaluate(() => face.setEnabled(true));
  await expect(page.locator('#expression-test')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#expression-test')).toBeHidden();
  expect(await page.evaluate(() => !!face.raf || !!face.timer)).toBe(false);
  await page.evaluate(() => face.dispose());
});

test('wrong portrait or missing model poses leave the original image and no animation', async ({ page }) => {
  for (const options of [{ badHash: true }, { broken: true }, { corruptPose: true }, { badMask: true }, { badSequence:true }]) {
    await prepare(page, options);
    expect(await page.evaluate(() => face.load())).toBe(false);
    await expect(page.locator('#expression-test')).toBeHidden();
    await expect(page.locator('#portrait')).toHaveAttribute('src', '/assets/avatar.png');
    expect(await page.evaluate(() => face.bitmaps.size)).toBe(0);
    await page.evaluate(() => face.dispose());
  }
});

test('changing reduced motion while open cancels blinking and scheduling', async ({ page }) => {
  await prepare(page);expect(await page.evaluate(() => face.load())).toBe(true);
  await page.evaluate(() => { face.setState('listening'); face.blink(); });
  await expect(page.locator('#expression-test')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#expression-test')).toBeHidden();
  expect(await page.evaluate(() => !!face.raf || !!face.timer)).toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('#expression-test')).toBeVisible();
  await page.evaluate(() => face.dispose());
});

test('disposing during model decoding releases late images and cannot restart expressions', async ({ page }) => {
  await prepare(page, { delay: true });
  await page.evaluate(() => { window.pendingExpression = face.load(); });
  await page.waitForTimeout(40);
  await page.evaluate(() => face.dispose());
  expect(await page.evaluate(() => pendingExpression)).toBe(false);
  await page.waitForTimeout(320);
  expect(await page.evaluate(() => face.bitmaps.size)).toBe(0);
  await expect(page.locator('#expression-test')).toBeHidden();
  expect(await page.evaluate(() => !!face.raf || !!face.timer)).toBe(false);
});

test('dispose immediately closes poses already decoded while a sibling request is pending', async ({ page }) => {
  await prepare(page, { delayOne: true });
  await page.evaluate(() => {
    window.decodedPoses = 0; window.closedPoses = 0;
    const original = createImageBitmap;
    window.createImageBitmap = async (...args) => {
      const bitmap = await original(...args); decodedPoses++;
      const close = bitmap.close.bind(bitmap); bitmap.close = () => { closedPoses++; close(); }; return bitmap;
    };
    window.pendingExpression = face.load();
  });
  await expect.poll(() => page.evaluate(() => face.loadingBitmaps?.size || 0)).toBeGreaterThanOrEqual(7);
  const acquired = await page.evaluate(() => face.loadingBitmaps.size);
  await page.evaluate(() => face.dispose());
  expect(await page.evaluate(() => closedPoses)).toBeGreaterThanOrEqual(acquired);
  expect(await page.evaluate(() => pendingExpression)).toBe(false);
  await expect(page.locator('#expression-test')).toBeHidden();
});
