class StreamingMicrophone extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Float32Array(512); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === 512) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(512); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('streaming-microphone', StreamingMicrophone);
