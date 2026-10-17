// AudioWorklet 处理器：一边录音，一边在指定位置把要放的声音写进输出。
// 发声位置和录音位置用同一套采样计数，所以两者相减就是延迟，不依赖任何时钟。
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sr = sampleRate
    this.recording = false
    this.chunks = []
    this.total = 0 // 已录到的采样数（同时就是录音时间轴上的位置）
    this.sounds = [] // [{ samples, at }]：要放的声音，以及它在录音时间轴上的位置
    this.emitted = [] // 每一段实际写出了多少样本，用来校验有没有发全

    this.port.onmessage = (e) => {
      const msg = e.data
      if (!msg) return

      if (msg.type === 'start') {
        this.chunks = []
        this.total = 0
        this.sounds = msg.sounds ?? []
        this.emitted = new Array(this.sounds.length).fill(0)
        this.recording = true
      } else if (msg.type === 'stop') {
        this.recording = false
        this.sounds = []
        const out = new Float32Array(this.total)
        let off = 0
        for (const c of this.chunks) {
          out.set(c, off)
          off += c.length
        }
        this.port.postMessage(
          { type: 'data', buffer: out, sampleRate: this.sr, emitted: this.emitted },
          [out.buffer]
        )
        this.chunks = []
        this.total = 0
      }
    }
  }

  process(inputs, outputs) {
    if (!this.recording) return true

    const ch = inputs[0] && inputs[0][0]
    const out = outputs[0] && outputs[0][0]

    // 发声：把每一段声音写进输出缓冲（本块覆盖的录音区间与发声区间取交集）
    if (out) {
      const base = this.total
      for (let i = 0; i < this.sounds.length; i++) {
        const s = this.sounds[i]
        const from = Math.max(base, s.at)
        const to = Math.min(base + out.length, s.at + s.samples.length)
        for (let pos = from; pos < to; pos++) {
          const k = pos - s.at
          out[pos - base] += s.samples[k]
          if (k + 1 > this.emitted[i]) this.emitted[i] = k + 1
        }
      }
    }

    if (ch && ch.length > 0) {
      this.chunks.push(new Float32Array(ch))
      this.total += ch.length
    }
    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
