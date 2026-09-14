// src/core/realtime/audio/micWorklet.ts

/**
 * AudioWorklet processor source. Exported as a STRING (not a file URL) because
 * the packaged plugin has no resolvable asset URL for this module; the capture
 * builds a Blob URL from this string at runtime. Down-converts mono Float32
 * frames to Int16 and posts them to the main thread.
 */
export const MIC_WORKLET_SOURCE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      const frame = input[0]
      const out = new Int16Array(frame.length)
      for (let i = 0; i < frame.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, frame[i]))
        out[i] = Math.round(clamped * 32767)
      }
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}
registerProcessor('mic-capture', MicCaptureProcessor)
`
