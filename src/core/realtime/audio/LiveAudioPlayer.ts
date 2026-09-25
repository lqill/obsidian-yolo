import { LIVE_OUTPUT_SAMPLE_RATE } from '../geminiLiveProtocol'

import { base64ToInt16, int16ToFloat32 } from './pcm'

export class LiveAudioPlayer {
  private context: AudioContext | null = null
  private nextStartTime = 0
  private readonly scheduled = new Set<AudioBufferSourceNode>()
  private disposed = false

  private ensureContext(): AudioContext {
    if (!this.context)
      this.context = new AudioContext({ sampleRate: LIVE_OUTPUT_SAMPLE_RATE })
    return this.context
  }

  enqueue(dataBase64: string): void {
    if (this.disposed) return
    const context = this.ensureContext()
    const samples = int16ToFloat32(base64ToInt16(dataBase64))
    const buffer = context.createBuffer(
      1,
      samples.length,
      LIVE_OUTPUT_SAMPLE_RATE,
    )
    buffer.copyToChannel(samples, 0)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    const startAt = Math.max(context.currentTime, this.nextStartTime)
    node.start(startAt)
    this.nextStartTime = startAt + buffer.duration
    this.scheduled.add(node)
    node.onended = () => this.scheduled.delete(node)
  }

  flush(): void {
    for (const node of this.scheduled) {
      try {
        node.stop()
      } catch {
        // node already stopped
      }
    }
    this.scheduled.clear()
    this.nextStartTime = this.context?.currentTime ?? 0
  }

  dispose(): void {
    this.flush()
    this.disposed = true
    void this.context?.close()
    this.context = null
  }
}
