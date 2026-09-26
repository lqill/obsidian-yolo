import { LIVE_INPUT_SAMPLE_RATE } from '../geminiLiveProtocol'

import { MIC_WORKLET_SOURCE } from './micWorklet'
import {
  float32ToInt16,
  int16ToBase64,
  int16ToFloat32,
  resampleLinear,
} from './pcm'

const FRAME_SIZE = 1600 // ~100 ms at 16 kHz

export type PcmMicCaptureOptions = {
  onFrame: (dataBase64: string) => void
  onLevel: (level: number) => void
}

/**
 * Desktop-only microphone capture at 16 kHz mono, emitted as ~100 ms base64
 * PCM16 frames. Prefers a native 16 kHz AudioContext and resamples linearly
 * when the platform hands back a different rate.
 */
export class PcmMicCapture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private pending = new Int16Array(0)
  private muted = false

  constructor(private readonly options: PcmMicCaptureOptions) {}

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      this.context = new AudioContext({ sampleRate: LIVE_INPUT_SAMPLE_RATE })
      this.source = this.context.createMediaStreamSource(this.stream)
      const blobUrl = URL.createObjectURL(
        new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      await this.context.audioWorklet.addModule(blobUrl)
      URL.revokeObjectURL(blobUrl)
      this.worklet = new AudioWorkletNode(this.context, 'mic-capture')
      this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const context = this.context
        const frame = new Int16Array(event.data)
        const resampled =
          context && context.sampleRate !== LIVE_INPUT_SAMPLE_RATE
            ? float32ToInt16(
                resampleLinear(
                  int16ToFloat32(frame),
                  context.sampleRate,
                  LIVE_INPUT_SAMPLE_RATE,
                ),
              )
            : frame
        this.pushFrame(resampled)
      }
      this.source.connect(this.worklet)
      this.worklet.connect(this.context.destination)
    } catch (error) {
      this.stop()
      throw error
    }
  }

  private pushFrame(frame: Int16Array): void {
    if (this.muted) return
    let level = 0
    for (let i = 0; i < frame.length; i += 1)
      level = Math.max(level, Math.abs(frame[i]) / 32768)
    this.options.onLevel(level)

    const merged = new Int16Array(this.pending.length + frame.length)
    merged.set(this.pending)
    merged.set(frame, this.pending.length)
    let offset = 0
    while (merged.length - offset >= FRAME_SIZE) {
      this.options.onFrame(
        int16ToBase64(merged.subarray(offset, offset + FRAME_SIZE)),
      )
      offset += FRAME_SIZE
    }
    this.pending = merged.slice(offset)
  }

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  stop(): void {
    this.worklet?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.stream = null
    this.context = null
    this.source = null
    this.worklet = null
    this.pending = new Int16Array(0)
  }
}
