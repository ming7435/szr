// V1 responds to actual audio volume. A video renderer can replace this class for V2.
export class AvatarRenderer {
  constructor(panel) {
    this.panel = panel;
    this.stage = panel.querySelector('.portrait-stage');
    this.bars = document.querySelector('#sound-bars');
    this.bars.replaceChildren(...Array.from({ length: 11 }, () => document.createElement('i')));
    this.enabled = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.level = 0;
    this.readLevel = null;
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }
  async attach(element, stream = null) {
    this.context ??= new AudioContext();
    await this.context.resume();
    this.analyser ??= this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.data ??= new Uint8Array(this.analyser.fftSize);
    this.source?.disconnect(this.analyser);
    if (stream) {
      this.source = this.context.createMediaStreamSource(stream);
      this.source.connect(this.analyser);
      // The <audio> element owns playback. Do not route the remote stream twice.
    } else {
      this.elementSources ??= new WeakMap();
      this.source = this.elementSources.get(element);
      if (!this.source) {
        this.source = this.context.createMediaElementSource(element);
        this.elementSources.set(element, this.source);
        this.source.connect(this.context.destination);
      }
      this.source.connect(this.analyser);
    }
    this.element = element;
  }
  reset() {
    this.element = null;
    this.source?.disconnect(this.analyser);
    this.level = 0;
  }
  tick(time) {
    let target = 0;
    if (this.element && !this.element.paused && this.analyser) {
      this.analyser.getByteTimeDomainData(this.data);
      let sum = 0;
      for (const value of this.data) sum += ((value - 128) / 128) ** 2;
      target = Math.min(1, Math.sqrt(sum / this.data.length) * 5.5);
    }
    this.level += (target - this.level) * .3;
    this.panel.style.setProperty('--stage-level', this.enabled ? this.level.toFixed(3) : '0');
    this.panel.classList.toggle('active', this.level > .01 && this.enabled);
    if (this.enabled && !document.fullscreenElement && !this.stage.classList.contains('coherent-face')) {
      const breath = Math.sin(time / 2700) * .0008;
      this.stage.style.transform = `scale(${1.005 + breath + this.level * .007}) translateY(${-this.level * .6}px)`;
    } else this.stage.style.transform = '';
    for (let i = 0; i < this.bars.children.length; i++) {
      const shape = .3 + .7 * Math.abs(Math.sin(time / 95 + i * 1.7));
      this.bars.children[i].style.height = `${3 + (this.enabled ? this.level * shape * 18 : 0)}px`;
    }
    requestAnimationFrame(this.tick);
  }
}
