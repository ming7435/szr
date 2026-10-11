// Photo-specific LivePortrait eye/brow poses. Speech stays on the audio-driven mouth.
const poseNames = ['neutral', 'blink25', 'blink50', 'blink75', 'blink100', 'attentive', 'gaze-left', 'gaze-right'];
const smooth = value => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
const patchCanvas = region => { const canvas = document.createElement('canvas'); canvas.width = region[2]; canvas.height = region[3]; return canvas; };

export class FaceExpression {
  constructor({ canvas, image }) {
    this.canvas = canvas; this.image = image;
    this.canvas.hidden = true; this.bitmaps = new Map();
    this.enabled = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    this.motionChanged = () => this.refresh();
    this.motionPreference.addEventListener('change', this.motionChanged);
    this.state = 'idle'; this.intensity = 0; this.target = 0; this.gaze = 0;
    this.raf = 0; this.timer = 0; this.ready = false; this.disposed = false; this.suspended = false;
    this.visibility = () => this.refresh();
    document.addEventListener('visibilitychange', this.visibility);
  }
  async load() {
    if (this.disposed) return false;
    if (this.loading) return this.loading;
    this.loading = this.loadAssets();
    return this.loading;
  }
  async loadAssets() {
    const acquired = new Map();
    this.loadingBitmaps = acquired;
    this.abort = new AbortController();
    const options = { signal: this.abort.signal };
    try {
      const base = new URL('./assets/face-expressions/', import.meta.url);
      const response = await fetch(new URL('manifest.json', base), options);
      if (!response.ok) throw new Error('Expression assets unavailable');
      const manifest = await response.json();
      const size = manifest.imageSize, region = manifest.region;
      if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.photoSHA256) ||
          !Array.isArray(size) || size.length !== 2 || !size.every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
          !Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger) ||
          region[0] < 0 || region[1] < 0 || region[2] <= 0 || region[3] <= 0 ||
          region[0] + region[2] > size[0] || region[1] + region[3] > size[1]) throw new Error('Invalid expression metadata');
      const masks = manifest.eyeMasks;
      if (!Array.isArray(masks) || masks.length !== 2 || masks.some(mask =>
        !Array.isArray(mask.center) || mask.center.length !== 2 || !mask.center.every(Number.isFinite) ||
        !Array.isArray(mask.radius) || mask.radius.length !== 2 || !mask.radius.every(n => Number.isFinite(n) && n > 0) ||
        !Number.isFinite(mask.feather) || mask.feather <= 0 || mask.feather > .5 ||
        mask.center[0] - mask.radius[0] < region[0] || mask.center[1] - mask.radius[1] < region[1] ||
        mask.center[0] + mask.radius[0] > region[0] + region[2] || mask.center[1] + mask.radius[1] > region[1] + region[3]
      )) throw new Error('Invalid eyelid bounds');
      const sequence = manifest.blinkSequence ?? ['blink25', 'blink50', 'blink75', 'blink100'];
      if (!Array.isArray(sequence) || sequence.length < 2 || sequence.length > 32 || new Set(sequence).size !== sequence.length ||
          sequence.some(name => typeof name !== 'string' || !/^blink(?:25|50|75|100|-frame-\d{2})$/.test(name))) throw new Error('Invalid blink sequence');
      await this.image.decode();
      if (this.image.naturalWidth !== size[0] || this.image.naturalHeight !== size[1]) throw new Error('Different portrait');
      const portraitUrl = this.image.currentSrc || this.image.src;
      const portrait = await fetch(portraitUrl, options);
      if (!portrait.ok) throw new Error('Portrait unavailable');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await portrait.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== manifest.photoSHA256 || this.disposed) throw new Error('Different portrait or closed renderer');
      // Collect every settled decode so a failed or late sibling cannot leak a bitmap.
      const results = await Promise.allSettled([...new Set([...poseNames, ...sequence])].map(async name => {
        const file = manifest.poses?.[name];
        if (typeof file !== 'string' || !/^[a-z0-9-]+\.png$/.test(file)) throw new Error('Invalid pose');
        const response = await fetch(new URL(file, base), options);
        if (!response.ok) throw new Error('Pose unavailable');
        const bytes = await response.arrayBuffer();
        const expectedHash = manifest.poseSHA256?.[name];
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash !== expectedHash) throw new Error('Different pose assets');
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        if (this.disposed) { bitmap.close(); throw new Error('Closed renderer'); }
        acquired.set(name, bitmap);
        if (bitmap.width !== region[2] || bitmap.height !== region[3]) throw new Error('Invalid pose size');
      }));
      if (this.disposed || results.some(result => result.status === 'rejected')) throw new Error('Incomplete poses');
      this.bitmaps = acquired; this.region = region; this.blinkSequence = sequence;
      this.canvas.width = size[0]; this.canvas.height = size[1];
      this.context = this.canvas.getContext('2d');
      this.prepareBlink(masks);
      this.ready = true;
      this.canvas.dataset.ready = 'true';
      this.loadingBitmaps = null;
      this.refresh(); return true;
    } catch {
      for (const bitmap of acquired.values()) bitmap.close();
      acquired.clear(); this.loadingBitmaps = null;
      this.canvas.hidden = true; return false;
    }
  }
  prepareBlink(masks) {
    const region = this.region;
    this.eyeMask = patchCanvas(region);
    const maskContext = this.eyeMask.getContext('2d'), pixels = maskContext.createImageData(region[2], region[3]);
    for (let y = 0; y < region[3]; y++) for (let x = 0; x < region[2]; x++) {
      let alpha = 0;
      for (const mask of masks) {
        const distance = Math.hypot((x + region[0] + .5 - mask.center[0]) / mask.radius[0], (y + region[1] + .5 - mask.center[1]) / mask.radius[1]);
        alpha = Math.max(alpha, 1 - smooth((distance - (1 - mask.feather)) / mask.feather));
      }
      const index = (y * region[2] + x) * 4;
      pixels.data.set([255, 255, 255, Math.round(alpha * 255)], index);
    }
    maskContext.putImageData(pixels, 0, 0);
    this.openEyes = patchCanvas(region); this.blinkPatch = patchCanvas(region);
    this.blinkFrames = new Map();
    for (const name of this.blinkSequence) {
      const frame = patchCanvas(region), c = frame.getContext('2d');
      c.drawImage(this.image, ...region, 0, 0, region[2], region[3]);
      c.drawImage(this.bitmaps.get(name), 0, 0);
      c.globalCompositeOperation = 'destination-in'; c.drawImage(this.eyeMask, 0, 0);
      this.blinkFrames.set(name, frame);
    }
  }
  drawBlink(position) {
    const region = this.region, lower = Math.floor(position), mix = position - lower;
    const patch = this.blinkPatch.getContext('2d');
    patch.clearRect(0, 0, region[2], region[3]);
    let from = this.blinkFrames.get(this.blinkSequence[lower - 1]);
    if (lower === 0) {
      // Reopen to the current expression, using opaque photo pixels inside the eyelid mask.
      // Outside the mask the existing brow layer is never replaced, even at full closure.
      const open = this.openEyes.getContext('2d');
      open.globalCompositeOperation = 'copy'; open.drawImage(this.image, ...region, 0, 0, region[2], region[3]);
      open.globalCompositeOperation = 'source-over'; open.drawImage(this.canvas, ...region, 0, 0, region[2], region[3]);
      open.globalCompositeOperation = 'destination-in'; open.drawImage(this.eyeMask, 0, 0);
      from = this.openEyes;
    }
    patch.globalCompositeOperation = 'source-over'; patch.globalAlpha = 1 - mix; patch.drawImage(from, 0, 0);
    patch.globalCompositeOperation = 'lighter'; patch.globalAlpha = mix;
    if (mix > 0) patch.drawImage(this.blinkFrames.get(this.blinkSequence[lower]), 0, 0);
    patch.globalAlpha = 1; patch.globalCompositeOperation = 'source-over';
    this.context.globalAlpha = 1; this.context.drawImage(this.blinkPatch, ...region);
  }
  setEnabled(enabled) { this.enabled = !!enabled; this.refresh(); }
  setSuspended(suspended) { this.suspended = !!suspended; this.lastTime = 0; this.refresh(); }
  setState(state) {
    const next = ['listening', 'thinking', 'responding'].includes(state) ? state : 'idle';
    this.canvas.dataset.state = next;
    if (next === this.state) return;
    this.state = next;
    this.gazeStart = null;
    this.target = this.state === 'listening' ? .7 : this.state === 'thinking' ? 1 : this.state === 'responding' ? .3 : 0;
    this.lastTime = 0; this.schedule();
  }
  setSpeech(level) {
    if (this.state !== 'responding') return;
    this.target = .16 + .34 * Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    this.schedule();
  }
  get active() { return this.ready && this.enabled && !this.motionPreference.matches && !this.disposed && !this.suspended && !document.hidden && !this.image.closest('.live-video'); }
  refresh() {
    if (!this.active) {
      cancelAnimationFrame(this.raf); clearTimeout(this.timer); this.raf = 0; this.timer = 0;
      this.blinkStart = null; this.gaze = 0; this.gazeStart = null; this.lastTime = 0; this.canvas.hidden = true; return;
    }
    this.schedule(); this.armBlink();
  }
  schedule() {
    if (this.active && !this.raf) this.raf = requestAnimationFrame(time => this.tick(time));
  }
  armBlink() {
    if (this.active && !this.timer) this.timer = setTimeout(() => { this.timer = 0; this.blink(); }, 3200 + Math.random() * 2800);
  }
  blink() {
    if (!this.active || this.blinkStart != null) return;
    this.blinkStart = performance.now(); this.schedule();
  }
  tick(time) {
    this.raf = 0;
    if (!this.active) { this.refresh(); return; }
    const dt = this.lastTime ? Math.min(80, time - this.lastTime) : 16; this.lastTime = time;
    this.intensity += (this.target - this.intensity) * (1 - Math.exp(-dt / 180));
    // Start thought looking forward, then ease back instead of dropping a gaze pose.
    if (this.state === 'thinking' && this.gazeStart == null) this.gazeStart = time;
    const gazeTarget = this.state === 'thinking' ? Math.sin((time - this.gazeStart) / 2100) * .25 : 0;
    this.gaze += (gazeTarget - this.gaze) * (1 - Math.exp(-dt / 200));
    const c = this.context; c.clearRect(...this.region);
    const draw = (name, strength) => {
      c.globalAlpha = Math.max(0, Math.min(1, strength));
      c.drawImage(this.bitmaps.get(name), ...this.region);
    };
    let pose = 'neutral';
    if (this.intensity > .01) {
      pose = 'attentive'; draw(pose, this.intensity);
      if (Math.abs(this.gaze) > .001) draw(this.gaze < 0 ? 'gaze-left' : 'gaze-right', Math.abs(this.gaze));
    }
    if (this.blinkStart != null) {
      const elapsed = time - this.blinkStart;
      // Close quickly and reopen softly, with no fixed closed-eye hold.
      let amount = elapsed < 70 ? smooth(elapsed / 70) : 1 - smooth((elapsed - 70) / 150);
      if (elapsed >= 220) { this.blinkStart = null; this.armBlink(); amount = 0; }
      if (amount > 0) {
        const position = amount * this.blinkSequence.length;
        this.drawBlink(position);
        pose = 'blink' + Math.max(1, Math.round(amount * 100));
      }
    }
    c.globalAlpha = 1; this.canvas.dataset.pose = pose;
    this.canvas.hidden = pose === 'neutral';
    if (this.blinkStart != null || Math.abs(this.target - this.intensity) > .003 || Math.abs(this.gaze) > .001 || this.state === 'thinking') this.schedule();
  }
  dispose() {
    this.disposed = true; this.ready = false; this.canvas.dataset.ready = 'false'; this.refresh();
    this.abort?.abort();
    for (const bitmap of this.loadingBitmaps?.values() || []) bitmap.close();
    this.loadingBitmaps?.clear();
    document.removeEventListener('visibilitychange', this.visibility);
    this.motionPreference.removeEventListener('change', this.motionChanged);
    for (const bitmap of this.bitmaps.values()) bitmap.close(); this.bitmaps.clear();
    this.blinkFrames?.clear(); this.eyeMask = null; this.openEyes = null; this.blinkPatch = null;
  }
}
