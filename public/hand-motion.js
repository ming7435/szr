// Small photo-local wrist motion. This preserves clasped fingers; it does not
// reconstruct unseen hands or generate free gestures from a still photograph.
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
const smooth = value => { const x = Math.max(0, Math.min(1, value)); return x*x*(3-2*x); };
const vertex = `attribute vec2 position; varying vec2 uv; void main(){uv=vec2((position.x+1.0)*.5,(1.0-position.y)*.5);gl_Position=vec4(position,0.0,1.0);}`;
const fragment = `precision highp float; varying vec2 uv; uniform sampler2D photo;
uniform vec2 size,center,radius,shift; uniform float tilt,strength;
void main(){vec2 p=uv*size,delta=p-center;
float mask=1.0-smoothstep(.65,1.0,length(delta/radius));
float edge=min(min(p.x,size.x-p.x),min(p.y,size.y-p.y));
mask*=smoothstep(4.0,20.0,edge);
vec2 movement=(shift+vec2(-delta.y,delta.x)*tilt)*mask*strength;
gl_FragColor=texture2D(photo,(p-movement)/size);}`;

export class HandMotion {
  constructor({ stage, image, source }) {
    Object.assign(this, { stage, image, source });
    this.ready = false; this.enabled = true; this.disposed = false; this.suspended = false; this.state = 'idle'; this.raf = 0; this.strength = 0;
    this.preference = matchMedia('(prefers-reduced-motion: reduce)');
    this.visibility = () => this.refresh(); this.resize = () => this.layout();
    this.preference.addEventListener('change', this.visibility); document.addEventListener('visibilitychange', this.visibility); document.addEventListener('fullscreenchange', this.resize);
    this.activity = new MutationObserver(() => this.readActivity()); this.activity.observe(source, { attributes: true, attributeFilter: ['hidden', 'data-audio-energy'] });
  }
  get active() { return this.ready && this.enabled && !this.disposed && !this.suspended && !this.preference.matches && !document.hidden && !this.stage.classList.contains('live-video'); }
  async load() { if (this.disposed) return false; return this.loading ??= this.loadAssets(); }
  async loadAssets() {
    this.abort = new AbortController(); const options = { signal: this.abort.signal };
    try {
      const response = await fetch(new URL('./assets/hand-motion/manifest.json', import.meta.url), options); if (!response.ok) throw new Error('No wrist metadata');
      const spec = await response.json(), size = spec.imageSize, region = spec.region;
      if (spec.schema !== 1 || !/^[a-f0-9]{64}$/.test(spec.photoSHA256) || !Array.isArray(size) || size.length !== 2 || !size.every(n => Number.isInteger(n) && n > 0 && n <= 8192) ||
          !Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger) || region[0] < 0 || region[1] < 0 || region[2] < 1 || region[3] < 1 || region[0]+region[2] > size[0] || region[1]+region[3] > size[1]) throw new Error('Invalid wrist bounds');
      for (const key of ['center', 'radius', 'maxShift']) if (!Array.isArray(spec[key]) || spec[key].length !== 2 || !spec[key].every(Number.isFinite)) throw new Error('Invalid wrist geometry');
      if (spec.radius.some(n => n <= 0 || n > 4096) || spec.maxShift.some(n => Math.abs(n) > 20) || !Number.isFinite(spec.maxTilt) || Math.abs(spec.maxTilt) > .012 || spec.center.some((n,i) => n < region[i] || n > region[i]+region[i+2])) throw new Error('Invalid wrist movement');
      await this.image.decode(); const photo = await fetch(this.image.currentSrc || this.image.src, options);
      if (!photo.ok || await digest(await photo.arrayBuffer()) !== spec.photoSHA256 || this.image.naturalWidth !== size[0] || this.image.naturalHeight !== size[1] || this.disposed) throw new Error('Different portrait or closed wrist renderer');
      this.spec = spec; this.canvas = document.createElement('canvas'); this.canvas.className = 'hand-motion'; this.canvas.hidden = true; this.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.width = region[2]; this.canvas.height = region[3];
      this.gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true }); if (!this.gl) throw new Error('No accelerated wrist renderer');
      const gl = this.gl; this.shaders = [];
      const compile = (type, code) => { const shader = gl.createShader(type); this.shaders.push(shader); gl.shaderSource(shader, code); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Wrist shader unavailable'); return shader; };
      this.program = gl.createProgram(); gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vertex)); gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Wrist program unavailable'); gl.useProgram(this.program);
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const crop = document.createElement('canvas'); crop.width = region[2]; crop.height = region[3]; crop.getContext('2d').drawImage(this.image, ...region, 0, 0, region[2], region[3]);
      this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crop);
      for (const [name, values] of Object.entries({ size: region.slice(2), center: spec.center.map((n,i) => n-region[i]), radius: spec.radius, shift: spec.maxShift })) gl.uniform2fv(gl.getUniformLocation(this.program, name), values);
      gl.uniform1f(gl.getUniformLocation(this.program, 'tilt'), spec.maxTilt); this.strengthLocation = gl.getUniformLocation(this.program, 'strength');
      this.contextLost = event => { event.preventDefault(); this.ready = false; this.refresh(); }; this.canvas.addEventListener('webglcontextlost', this.contextLost);
      this.stage.append(this.canvas); this.ready = true; this.canvas.dataset.ready = 'true'; this.draw(0);
      this.observer = new ResizeObserver(this.resize); this.observer.observe(this.stage); this.observer.observe(this.image); this.layout(); this.refresh(); return true;
    } catch { this.ready = false; this.release(); return false; }
  }
  layout() {
    if (!this.ready) return;
    const r = this.image.getBoundingClientRect(), stage = this.stage.getBoundingClientRect(), style = getComputedStyle(this.image), [w,h] = this.spec.imageSize;
    const scale = (style.objectFit === 'contain' ? Math.min : Math.max)(r.width/w, r.height/h), position = style.objectPosition.split(' ').map(n => parseFloat(n)/100), [x,y,cw,ch] = this.spec.region;
    Object.assign(this.canvas.style, { left: r.left-stage.left+(r.width-w*scale)*(position[0] || 0)+x*scale+'px', top: r.top-stage.top+(r.height-h*scale)*(position[1] || 0)+y*scale+'px', width: cw*scale+'px', height: ch*scale+'px' });
  }
  draw(strength) {
    if (!this.ready || this.disposed) return;
    const value = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0));
    this.gl.uniform1f(this.strengthLocation, value); this.gl.drawArrays(this.gl.TRIANGLES, 0, 6); this.canvas.dataset.gestureStrength = value.toFixed(4);
  }
  setState(state) { this.state = ['listening','thinking','responding'].includes(state) ? state : 'idle'; this.refresh(); }
  setEnabled(enabled) { this.enabled = !!enabled; this.refresh(); }
  setSuspended(suspended) { this.suspended = !!suspended; this.layout(); this.refresh(); }
  readActivity() { this.energy = this.active && !this.source.hidden ? Math.max(0, Math.min(1, Number(this.source.dataset.audioEnergy || 0)*6 || 0)) : 0; this.refresh(); }
  refresh() {
    if (!this.active || this.state !== 'responding') { this.reset(); return; }
    // A brief missing lip frame must not repeatedly restart the wrist at zero.
    // Hide during the gap; stop/interruption changes state and resets everything.
    if (this.source.hidden) { this.pause(); return; }
    this.schedule();
  }
  schedule() { if (this.active && !this.raf) this.raf = requestAnimationFrame(time => this.tick(time)); }
  tick(time) {
    this.raf = 0; if (!this.active || this.state !== 'responding') { this.reset(); return; }
    if (this.source.hidden) { this.pause(); return; }
    const dt = this.lastTime ? Math.min(80, Math.max(0, time-this.lastTime)) : 16; this.lastTime = time;
    if (this.gestureStart == null && this.energy > .04 && (!this.nextGesture || time >= this.nextGesture)) { this.gestureStart = time; this.nextGesture = time+2600+Math.random()*1000; }
    let strength = 0;
    if (this.gestureStart != null) {
      const t = Math.max(0,(time-this.gestureStart)/1900);
      if (t >= 1) this.gestureStart = null;
      else { const phase=t<.34?t/.34*.5:.5+(t-.34)/.66*.5; strength=.85*Math.sin(Math.PI*phase)**2; }
    }
    if (this.energy <= .005) {
      // The lip renderer holds its last picture during gaps and an 80ms end fade.
      // Finish the wrist return within that same fade, before the patch is hidden.
      if (this.silenceStart == null) { this.silenceStart = time; this.releaseStrength = this.strength; }
      this.strength = this.releaseStrength * (1-smooth((time-this.silenceStart)/80));
    } else {
      this.silenceStart = null;
      this.strength += (strength-this.strength) * (1-Math.exp(-dt/90));
    }
    if (this.strength > .0005) { this.draw(this.strength); this.canvas.hidden = false; }
    else { this.canvas.hidden = true; this.canvas.dataset.gestureStrength = '0'; }
    this.schedule();
  }
  pause() { cancelAnimationFrame(this.raf); this.raf = 0; if (this.canvas) { this.canvas.hidden = true; this.canvas.dataset.gestureStrength = '0'; } }
  reset() { this.pause(); this.gestureStart = null; this.nextGesture = 0; this.strength = 0; this.lastTime = 0; this.silenceStart = null; }
  release() { this.canvas?.remove(); const gl = this.gl; if (gl) { if (this.texture) gl.deleteTexture(this.texture); if (this.buffer) gl.deleteBuffer(this.buffer); if (this.program) gl.deleteProgram(this.program); for (const shader of this.shaders || []) gl.deleteShader(shader); } }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.ready = false; this.reset(); this.abort?.abort(); this.activity.disconnect(); this.observer?.disconnect();
    document.removeEventListener('visibilitychange', this.visibility); document.removeEventListener('fullscreenchange', this.resize); this.preference.removeEventListener('change', this.visibility);
    this.canvas?.removeEventListener('webglcontextlost', this.contextLost); this.release();
  }
}
