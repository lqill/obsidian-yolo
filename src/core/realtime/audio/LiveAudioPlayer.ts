import { LIVE_OUTPUT_SAMPLE_RATE } from '../geminiLiveProtocol'

import { base64ToInt16, int16ToFloat32 } from './pcm'
import {
  VoiceAudioError,
  getAudioContextConstructor,
  unlockAudioContext,
} from './voiceAudioSupport'

export type LiveAudioPlayerOptions = {
  /**
   * Output could not be unlocked (the OS suspended the context mid-session:
   * audio-focus steal, headset unplug, a backgrounding race). Reported rather
   * than swallowed — a session that cannot speak must say so, not go quiet.
   */
  onFailure?: (error: VoiceAudioError) => void
}

/**
 * Playback of the Live API's 24 kHz PCM16 audio.
 *
 * The context is created by `prepare()` during the start gesture, never lazily
 * inside `enqueue()`: enqueue runs on a WebSocket message event, which carries no
 * user activation, so a lazily created context would stay `suspended` and the
 * user would hear a healthy session say nothing.
 */
export class LiveAudioPlayer {
  private context: AudioContext | null = null
  private nextStartTime = 0
  private readonly scheduled = new Set<AudioBufferSourceNode>()
  private disposed = false
  /**
   * Playback is suspended while the host is backgrounded; queued frames are
   * dropped rather than played late, because the model has already moved on.
   */
  private paused = false
  /** One recovery in flight at a time, however many frames arrive meanwhile. */
  private recovering = false

  constructor(private readonly options: LiveAudioPlayerOptions = {}) {}

  private ensureContext(): AudioContext {
    if (!this.context) {
      const Context = getAudioContextConstructor()
      if (!Context)
        throw new Error('Voice playback needs an AudioContext constructor')
      this.context = new Context({ sampleRate: LIVE_OUTPUT_SAMPLE_RATE })
    }
    return this.context
  }

  /**
   * Creates and unlocks the output context while the start still has the user's
   * activation, so the first server frame is already audible.
   */
  async prepare(): Promise<void> {
    if (this.disposed) return
    await unlockAudioContext(this.ensureContext())
  }

  private recover(context: AudioContext): void {
    if (this.recovering) return
    this.recovering = true
    void unlockAudioContext(context)
      .catch((error: unknown) => {
        // A recovery that lands after `dispose` belongs to a stopped session.
        if (this.disposed) return
        this.options.onFailure?.(
          error instanceof VoiceAudioError
            ? error
            : new VoiceAudioError(
                'audio_suspended',
                error instanceof Error ? error.message : String(error),
                { cause: error },
              ),
        )
      })
      .finally(() => {
        this.recovering = false
      })
  }

  enqueue(dataBase64: string): void {
    if (this.disposed || this.paused) return
    const context = this.ensureContext()
    if (context.state !== 'running') this.recover(context)
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
      // Idempotent per the Web Audio spec: stopping an ended node is a no-op.
      node.stop()
    }
    this.scheduled.clear()
    this.nextStartTime = this.context?.currentTime ?? 0
  }

  /** Suspends output and drops anything queued; reversible via `resume`. */
  async pause(): Promise<void> {
    if (this.paused || !this.context) return
    this.paused = true
    this.flush()
    try {
      await this.context.suspend()
    } catch {
      // Already reclaimed by the OS — it is not running either way.
    }
  }

  async resume(): Promise<void> {
    if (!this.paused || this.disposed || !this.context) return
    await unlockAudioContext(this.context)
    this.paused = false
    this.nextStartTime = this.context.currentTime
  }

  dispose(): void {
    this.flush()
    this.disposed = true
    this.paused = false
    this.recovering = false
    void this.context?.close()
    this.context = null
  }
}
