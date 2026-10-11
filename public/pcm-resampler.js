// Stateful low-pass FIR resampling. The source is 24 kHz PCM16LE, output 16 kHz.
// Keeping phase and history across messages preserves timing and voice pitch.
export class PCMResampler {
  constructor() {
    this.radius = 24; this.cutoff = .31;
    this.weights = [0, .5].map(fraction => {
      const weights = [];
      for (let k = -this.radius; k <= this.radius; k++) {
        const distance = fraction - k;
        const sinc = Math.abs(distance) < 1e-10 ? 2 * this.cutoff : Math.sin(2 * Math.PI * this.cutoff * distance) / (Math.PI * distance);
        const window = Math.abs(distance) <= this.radius ? .5 + .5 * Math.cos(Math.PI * distance / this.radius) : 0;
        weights.push(sinc * window);
      }
      const sum = weights.reduce((a, b) => a + b, 0); return weights.map(weight => weight / sum);
    });
    this.reset();
  }
  reset() { this.samples = []; this.offset = 0; this.total = 0; this.produced = 0; this.first = 0; this.last = 0; this.finished = false; }
  push(bytes) {
    if (this.finished || bytes.byteLength % 2) throw new Error('实时音频分块格式不正确。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i += 2) { const value = view.getInt16(i, true); if (!this.total) this.first = value; this.last = value; this.samples.push(value); this.total++; }
    return this.render(false);
  }
  flush() { if (this.finished) return new Uint8Array(); this.finished = true; return this.render(true); }
  render(final) {
    const output = [], limit = Math.floor(this.total * 2 / 3);
    while (this.produced < limit) {
      const center = this.produced * 1.5, base = Math.floor(center);
      if (!final && base + this.radius >= this.total) break;
      const weights = this.weights[this.produced % 2]; let sum = 0;
      for (let k = -this.radius; k <= this.radius; k++) {
        const index = base + k;
        const value = index < 0 ? this.first : index >= this.total ? this.last : this.samples[index - this.offset];
        sum += value * weights[k + this.radius];
      }
      output.push(Math.max(-32768, Math.min(32767, Math.round(sum)))); this.produced++;
    }
    const keepFrom = Math.max(this.offset, Math.floor(this.produced * 1.5) - this.radius);
    this.samples.splice(0, keepFrom - this.offset); this.offset = keepFrom;
    const bytes = new Uint8Array(output.length * 2), view = new DataView(bytes.buffer);
    output.forEach((sample, i) => view.setInt16(i * 2, sample, true)); return bytes;
  }
}
