import { LIVE_INPUT_SAMPLE_RATE } from '../geminiLiveProtocol'

import { MIC_WORKLET_SOURCE } from './micWorklet'
import {
  float32ToInt16,
  int16ToBase64,
  int16ToFloat32,
  resampleLinear,
} from './pcm'
import {
  VoiceAudioError,
  getAudioContextConstructor,
  toVoiceMicError,
  unlockAudioContext,
} from './voiceAudioSupport'

const FRAME_SIZE = 1600 // ~100 ms at 16 kHz

/**
 * How long a `mute` may last before it counts as a lost microphone. `mute` is not
 * terminal — Android raises it for transient interruptions (a call overlay, a
 * permission blip) and Chromium can raise it right after acquisition before the
 * first frames arrive, and the track then recovers on its own. Reporting that as
 * a dead session would fail a live call loudly for nothing; a mute that never
 * clears really is a lost microphone and must be reported.
 */
const MUTE_LOSS_DELAY_MS = 2000

/** `getUserMedia` constraints for a narrowband speech stream. */
const CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

export type PcmMicCaptureOptions = {
  onFrame: (dataBase64: string) => void
  onLevel: (level: number) => void
  /**
   * The OS track ended or was muted — a revoked microphone permission on
   * Android, or an unplugged headset. Without this the session keeps reporting
   * "Listening" while capturing nothing.
   */
  onLost?: (detail: string) => void
}

/**
 * Microphone capture at 16 kHz mono, emitted as ~100 ms base64 PCM16 frames.
 * Prefers a native 16 kHz AudioContext and resamples linearly when the platform
 * hands back a different rate.
 *
 * Two platform facts shape this class, both invisible on the desktop WebAudio
 * build the feature was written against:
 *
 * - A WebView context starts `suspended` unless it is created inside a user
 *   gesture, so the context is explicitly unlocked after construction; a session
 *   that captured nothing would otherwise look healthy.
 * - Chrome only pulls an `AudioWorkletNode` that reaches the destination, so the
 *   capture graph ends at a **zero-gain** node rather than at the speakers. The
 *   graph still reaches the destination (so it runs), but the microphone is not
 *   monitored — on a phone held next to the speaker the direct connection is a
 *   howl loop.
 */
export class PcmMicCapture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private pending = new Int16Array(0)
  private mutedByUser = false
  /** The mic is released while the host is backgrounded. */
  private suspended = false
  /** The track the handlers below are attached to, kept so they detach there. */
  private watched: {
    track: MediaStreamTrack
    ended: () => void
    mute: () => void
    unmute: () => void
  } | null = null
  /** Pending `mute` escalation; cleared by `unmute`, `stop`, and `suspend`. */
  private muteLossTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped by `stop` and by every `start`/`resume`, so an acquisition that
   * resolves after its own session was torn down can tell. `stop()` is
   * synchronous while `getUserMedia` is not — on Android the permission prompt
   * keeps it pending for seconds — so without this a user who taps End mid-prompt
   * gets a microphone (and the OS mic indicator) left running with nobody
   * listening, and loss handlers attached to a dead session.
   */
  private generation = 0

  constructor(private readonly options: PcmMicCaptureOptions) {}

  async start(): Promise<void> {
    if (this.context) return
    const generation = ++this.generation
    try {
      const stream = await this.acquireStream()
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream
      this.watchTrack(stream)
      const Context = getAudioContextConstructor()
      if (!Context)
        throw new VoiceAudioError(
          'mic_unavailable',
          'No AudioContext constructor',
        )
      this.context = new Context({ sampleRate: LIVE_INPUT_SAMPLE_RATE })
      this.source = this.context.createMediaStreamSource(this.stream)
      const blobUrl = URL.createObjectURL(
        new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      try {
        await this.context.audioWorklet.addModule(blobUrl)
      } finally {
        // Revoked on the failure path too: `stop()` in the catch below cannot
        // see a URL it was never handed.
        URL.revokeObjectURL(blobUrl)
      }
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
      this.sink = this.context.createGain()
      // Zero gain, not `worklet.connect(destination)`: the worklet must reach
      // the destination to be pulled, and monitoring the microphone through a
      // phone's speaker feeds back.
      this.sink.gain.value = 0
      this.source.connect(this.worklet)
      this.worklet.connect(this.sink)
      this.sink.connect(this.context.destination)
      await unlockAudioContext(this.context)
    } catch (error) {
      this.stop()
      throw error instanceof VoiceAudioError ? error : toVoiceMicError(error)
    }
  }

  private async acquireStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS)
    } catch (error) {
      throw toVoiceMicError(error)
    }
  }

  /**
   * Attaches the loss detectors to the current track and detaches the old one.
   * `ended` is terminal and reported at once; `mute` only escalates if it
   * persists (see `MUTE_LOSS_DELAY_MS`).
   */
  private watchTrack(stream: MediaStream | null): void {
    this.detachTrackHandlers()
    const track = stream?.getAudioTracks()[0]
    if (!track) return
    const label = track.label || 'default'
    const ended = () => {
      this.clearMuteTimer()
      this.options.onLost?.(`Microphone track ended (${label})`)
    }
    const mute = () => {
      if (this.muteLossTimer !== null) return
      this.muteLossTimer = setTimeout(() => {
        this.muteLossTimer = null
        this.options.onLost?.(`Microphone track muted (${label})`)
      }, MUTE_LOSS_DELAY_MS)
    }
    const unmute = () => this.clearMuteTimer()
    track.addEventListener('ended', ended)
    track.addEventListener('mute', mute)
    track.addEventListener('unmute', unmute)
    this.watched = { track, ended, mute, unmute }
  }

  private detachTrackHandlers(): void {
    this.clearMuteTimer()
    const watched = this.watched
    if (watched) {
      watched.track.removeEventListener('ended', watched.ended)
      watched.track.removeEventListener('mute', watched.mute)
      watched.track.removeEventListener('unmute', watched.unmute)
    }
    this.watched = null
  }

  private clearMuteTimer(): void {
    if (this.muteLossTimer === null) return
    clearTimeout(this.muteLossTimer)
    this.muteLossTimer = null
  }

  private pushFrame(frame: Int16Array): void {
    if (this.isMuted()) return
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

  private isMuted(): boolean {
    return this.mutedByUser || this.suspended
  }

  setMuted(muted: boolean): void {
    this.mutedByUser = muted
  }

  /**
   * Releases the OS microphone while keeping the audio graph intact. Android
   * suspends the WebView's audio hardware when the app is backgrounded but keeps
   * the socket alive, so a backgrounded session must not hold `RECORD_AUDIO`
   * (the OS mic indicator stays lit) or keep decoding frames.
   *
   * Reversible: `resume` re-acquires the stream onto the same worklet.
   */
  async suspend(): Promise<void> {
    if (this.suspended || !this.context) return
    this.suspended = true
    this.detachTrackHandlers()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.source?.disconnect()
    this.source = null
    this.pending = new Int16Array(0)
    try {
      await this.context.suspend()
    } catch {
      // A context the OS already reclaimed cannot be suspended; the state is
      // not `running` either way, which is what the suspend achieves.
    }
  }

  /**
   * Re-acquires the microphone after `suspend`. Fails loudly with a named
   * `VoiceAudioError` so a session that cannot come back reports
   * `mic_permission_denied` (Android revoked the grant) rather than silence.
   *
   * A failure partway through must not leave the microphone open: on Android the
   * OS mic indicator would stay lit with nobody listening, and the session would
   * look recovered while it is not.
   */
  async resume(): Promise<void> {
    if (!this.suspended) return
    const context = this.context
    if (!context)
      throw new VoiceAudioError('mic_unavailable', 'Capture was not started')
    const generation = ++this.generation
    const stream = await this.acquireStream()
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    try {
      this.stream = stream
      this.watchTrack(stream)
      const source = context.createMediaStreamSource(stream)
      if (this.worklet) source.connect(this.worklet)
      this.source = source
      await unlockAudioContext(context)
    } catch (error) {
      this.detachTrackHandlers()
      stream.getTracks().forEach((track) => track.stop())
      if (this.stream === stream) this.stream = null
      this.source?.disconnect()
      this.source = null
      throw error instanceof VoiceAudioError ? error : toVoiceMicError(error)
    }
    this.suspended = false
  }

  stop(): void {
    this.generation += 1
    this.detachTrackHandlers()
    this.worklet?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.stream = null
    this.context = null
    this.source = null
    this.worklet = null
    this.sink = null
    this.pending = new Int16Array(0)
    this.suspended = false
    this.mutedByUser = false
  }
}
