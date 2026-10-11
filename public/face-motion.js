// One photo-bound geometry for the portrait, audible lips and eye layer.
let nextId = 0;
const clamp = value => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
const namespace = 'http://www.w3.org/2000/svg';
function node(name, attributes = {}) { const element = document.createElementNS(namespace, name); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value)); return element; }

export class FaceMotion {
  constructor({ element, stage, image, source, onActivity }) {
    Object.assign(this, { element, stage, image, source, onActivity });
    this.id = 'face-motion-' + ++nextId; this.state = 'idle'; this.ready = false; this.disposed = false; this.suspended = false;
    this.preference = matchMedia('(prefers-reduced-motion: reduce)'); this.enabled = !this.preference.matches;
    this.energy = 0; this.targetEnergy = 0; this.pitch = 0; this.yaw = 0; this.posture = [0, 0]; this.raf = 0;
    this.visibility = () => this.refresh(); this.resize = () => this.layout();
    this.preference.addEventListener('change', this.visibility); document.addEventListener('visibilitychange', this.visibility); document.addEventListener('fullscreenchange', this.resize);
    this.activity = new MutationObserver(() => this.readActivity());
    this.activity.observe(source, { attributes: true, attributeFilter: ['data-audio-energy', 'hidden'] });
    this.mode = new MutationObserver(this.visibility); this.mode.observe(stage, { attributes: true, attributeFilter: ['class'] });
  }
  get active() { return this.ready && this.enabled && !this.preference.matches && !this.disposed && !this.suspended && !document.hidden && !this.stage.classList.contains('live-video'); }
  async load() {
    if (this.disposed) return false;
    return this.loading ??= this.loadAssets();
  }
  async loadAssets() {
    const acquired = new Set(); this.pendingUrls = acquired; this.abort = new AbortController();
    const options = { signal: this.abort.signal };
    try {
      const base = new URL('./assets/face-motion/', import.meta.url);
      const response = await fetch(new URL('manifest.json', base), options); if (!response.ok) throw new Error('Motion unavailable');
      const manifest = await response.json(), size = manifest.imageSize;
      if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.photoSHA256) ||
          !Array.isArray(size) || size.length !== 2 || !size.every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
          !Number.isFinite(manifest.scale) || manifest.scale <= 0 || manifest.scale > .025) throw new Error('Invalid motion metadata');
      const region = manifest.region ?? [0, 0, ...size];
      if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger) ||
          region[0] < 0 || region[1] < 0 || region[2] <= 0 || region[3] <= 0 ||
          region[0] + region[2] > size[0] || region[1] + region[3] > size[1]) throw new Error('Invalid motion bounds');
      const fieldSize = manifest.fieldSize ?? size;
      if (!Array.isArray(fieldSize) || fieldSize.length !== 2 ||
          !((fieldSize[0] === size[0] && fieldSize[1] === size[1]) || (fieldSize[0] === region[2] && fieldSize[1] === region[3]))) throw new Error('Invalid field bounds');
      await this.image.decode();
      if (this.image.naturalWidth !== size[0] || this.image.naturalHeight !== size[1]) throw new Error('Different portrait');
      const photo = await fetch(this.image.currentSrc || this.image.src, options);
      if (!photo.ok || await hash(await photo.arrayBuffer()) !== manifest.photoSHA256 || this.disposed) throw new Error('Different portrait or closed motion');
      const results = await Promise.allSettled(['pitch', 'yaw'].map(async name => {
        const filename = manifest.fields?.[name], expected = manifest.fieldSHA256?.[name];
        if (!/^[a-z-]+\.png$/.test(filename) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid motion field');
        const response = await fetch(new URL(filename, base), options); if (!response.ok) throw new Error('Missing motion field');
        const bytes = await response.arrayBuffer(); if (await hash(bytes) !== expected) throw new Error('Wrong motion field');
        const blob = new Blob([bytes], { type: 'image/png' }), bitmap = await createImageBitmap(blob);
        const valid = bitmap.width === fieldSize[0] && bitmap.height === fieldSize[1]; bitmap.close();
        if (!valid || this.disposed) throw new Error('Invalid field dimensions or closed motion');
        const url = URL.createObjectURL(blob); acquired.add(url); return { name, url };
      }));
      if (this.disposed || results.some(row => row.status === 'rejected')) throw new Error('Incomplete motion fields');
      this.urls = acquired; this.pendingUrls = null; this.size = size; this.scale = manifest.scale;
      this.svg = node('svg', { width: 0, height: 0, 'aria-hidden': 'true' });
      this.svg.style.cssText = 'position:absolute;pointer-events:none;';
      const bounds = { x: region[0] / size[0], y: region[1] / size[1], width: region[2] / size[0], height: region[3] / size[1] };
      const filter = node('filter', { id: this.id, ...bounds, filterUnits: 'objectBoundingBox', primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' });
      this.maps = {};
      for (const { value: { name, url } } of results) {
        const fieldBounds = fieldSize[0] === size[0] && fieldSize[1] === size[1] ? { x: 0, y: 0, width: 1, height: 1 } : bounds;
        filter.append(node('feImage', { href: url, ...fieldBounds, preserveAspectRatio: 'none', result: name + '-raw' }));
        const transfer = node('feComponentTransfer', { ...bounds, in: name + '-raw', result: name + '-map' });
        // 128 is exactly neutral after correction; unchanged scene pixels must not drift.
        for (const channel of ['R', 'G']) transfer.append(node('feFunc' + channel, { type: 'linear', slope: 1, intercept: .5 - 128 / 255 }));
        filter.append(transfer);
        this.maps[name] = node('feDisplacementMap', { ...bounds, in: name === 'pitch' ? 'SourceGraphic' : 'pitch-source', in2: name + '-map', xChannelSelector: 'R', yChannelSelector: 'G', scale: 0, result: name + '-source' });
        filter.append(this.maps[name]);
      }
      this.svg.append(filter); document.body.append(this.svg);
      // Keep the unchanged scene underneath; expensive filter passes touch only the head.
      if (region[2] !== size[0] || region[3] !== size[1]) {
        this.backdrop = this.image.cloneNode(false); this.backdrop.removeAttribute('id');
        this.backdrop.classList.add('face-motion-backing'); this.backdrop.alt = ''; this.backdrop.setAttribute('aria-hidden', 'true');
        this.element.before(this.backdrop);
      }
      this.ready = true; this.element.dataset.motionReady = 'true'; this.stage.classList.add('coherent-face');
      this.observer = new ResizeObserver(this.resize); this.observer.observe(this.stage); this.layout(); this.refresh();
      return true;
    } catch {
      for (const url of acquired) URL.revokeObjectURL(url); acquired.clear(); this.pendingUrls = null;
      return false;
    }
  }
  layout() {
    if (!this.ready || this.disposed) return;
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    const contain = !!document.fullscreenElement?.contains(this.stage) || getComputedStyle(this.image).objectFit === 'contain';
    const scale = (contain ? Math.min : Math.max)(width / this.size[0], height / this.size[1]);
    const position = parseFloat(getComputedStyle(this.image).objectPosition.split(' ')[1]) / 100;
    const w = this.size[0] * scale, h = this.size[1] * scale;
    const geometry = { width: w + 'px', height: h + 'px', left: (width - w) * .5 + 'px', top: (height - h) * (contain ? .5 : Number.isFinite(position) ? position : .21) + 'px' };
    Object.assign(this.element.style, geometry);
    if (this.backdrop) Object.assign(this.backdrop.style, geometry);
  }
  readActivity() {
    if (this.disposed) return;
    const raw = Number(this.source.dataset.audioEnergy || 0);
    this.targetEnergy = this.active && !this.source.hidden ? Math.max(0, Math.min(1, Number.isFinite(raw) ? raw * 6 : 0)) : 0;
    if (this.source.hidden || !this.active) { this.energy = 0; this.nodStart = null; }
    this.onActivity?.(this.targetEnergy); this.schedule();
  }
  setState(state) {
    const next = ['listening', 'thinking', 'responding'].includes(state) ? state : 'idle';
    if (next === this.state) return;
    this.state = next; this.nextPosture = 0;
    this.listeningNod = next === 'listening' ? 'pending' : null;
    if (next !== 'responding') { this.targetEnergy = 0; this.energy = 0; this.nodStart = null; this.onActivity?.(0); }
    this.schedule();
  }
  setEnabled(enabled) { this.enabled = !!enabled; this.refresh(); }
  setSuspended(suspended) { this.suspended = !!suspended; this.lastTime = 0; this.layout(); this.refresh(); }
  refresh() {
    if (!this.active) {
      cancelAnimationFrame(this.raf); this.raf = 0; this.lastTime = 0; this.energy = 0; this.targetEnergy = 0; this.nodStart = null; this.listeningNod = null;
      this.element.style.filter = ''; this.onActivity?.(0); return;
    }
    this.readActivity(); this.schedule();
  }
  schedule() { if (this.active && !this.raf) this.raf = requestAnimationFrame(time => this.tick(time)); }
  render(pitch, yaw) {
    if (!this.active) return;
    // At most .02 source pixels of rounding, below visible movement at display size.
    const p = Math.round(clamp(pitch) * 400) / 400, y = Math.round(clamp(yaw) * 400) / 400;
    if (this.renderedPitch !== p) {
      this.maps.pitch.setAttribute('scale', String(p * this.scale));
      this.element.dataset.pitch = p.toFixed(4); this.renderedPitch = p;
    }
    if (this.renderedYaw !== y) {
      this.maps.yaw.setAttribute('scale', String(y * this.scale));
      this.element.dataset.yaw = y.toFixed(4); this.renderedYaw = y;
    }
    const filter = `url(#${this.id})`;
    if (this.element.style.filter !== filter) this.element.style.filter = filter;
  }
  tick(time) {
    this.raf = 0; if (!this.active) { this.refresh(); return; }
    const dt = this.lastTime ? Math.min(80, Math.max(0, time - this.lastTime)) : 16; this.lastTime = time;
    const previous = this.energy; this.energy += (this.targetEnergy - this.energy) * (1 - Math.exp(-dt / 220));
    const speaking = !this.source.hidden && this.targetEnergy > .005;
    if (speaking && previous < .23 && this.energy >= .23 && (!this.lastNod || time - this.lastNod > 1300)) { this.nodStart = time; this.lastNod = time; }
    if (!this.nextPosture || time >= this.nextPosture) {
      const amount = speaking ? .55 : this.state === 'thinking' ? .35 : this.state === 'listening' ? .25 : .06;
      this.posture = [(Math.random() - .5) * amount, (Math.random() - .5) * amount * 1.4]; this.nextPosture = time + 3500 + Math.random() * 2500;
    }
    let nod = 0;
    if (this.nodStart != null) { const t = (time - this.nodStart) / 900; if (t >= 1) this.nodStart = null; else nod = .5 * Math.sin(Math.PI * Math.max(0, t)) ** 2; }
    if (this.listeningNod === 'pending') this.listeningNod = time;
    if (Number.isFinite(this.listeningNod) && this.listeningNod != null) { const t = (time-this.listeningNod)/1100; if(t >= 1) this.listeningNod = null; else nod += .26*Math.sin(Math.PI*Math.max(0,t))**2; }
    const pitch = this.posture[0] + nod, yaw = this.posture[1];
    this.pitch += (pitch - this.pitch) * (1 - Math.exp(-dt / 200)); this.yaw += (yaw - this.yaw) * (1 - Math.exp(-dt / 550));
    this.render(this.pitch, this.yaw); this.schedule();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false; this.element.dataset.motionReady = 'false'; this.refresh(); this.abort?.abort(); this.activity.disconnect(); this.mode.disconnect(); this.observer?.disconnect();
    document.removeEventListener('visibilitychange', this.visibility); document.removeEventListener('fullscreenchange', this.resize); this.preference.removeEventListener('change', this.visibility);
    for (const urls of [this.urls, this.pendingUrls]) { for (const url of urls || []) URL.revokeObjectURL(url); urls?.clear(); }
    this.svg?.remove(); this.backdrop?.remove(); this.stage.classList.remove('coherent-face');
  }
}
