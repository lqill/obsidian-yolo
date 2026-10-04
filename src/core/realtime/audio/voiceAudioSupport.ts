// src/core/realtime/audio/voiceAudioSupport.ts
/**
 * What the host platform can actually do, decided by capability rather than by
 * `Platform`. Obsidian's Android app is a Capacitor WebView: `getUserMedia`
 * works, but only while the app holds `RECORD_AUDIO` and its
 * `WebChromeClient` grants `RESOURCE_AUDIO_CAPTURE`. A desktop-only gate is
 * therefore the wrong question — the platform-specific failure modes deserve a
 * named reason each so the control bar can say what is actually wrong.
 */

/**
 * Why the host cannot run a voice session at the audio level. Core names the
 * reason; the UI owns the wording.
 */
export type VoiceAudioSupportFailure =
  /**
   * `navigator.mediaDevices` is absent. In a WebView this is the signature of a
   * non-secure origin (Obsidian Android serves `http(s)://localhost`, which is
   * secure, so a hit means a genuine WebView capability gap).
   */
  | 'insecure_context'
  /** No `AudioContext` constructor (pre-Chromium-66 WebView). */
  | 'audio_context_unsupported'
  /** No `AudioWorkletNode` (capture needs a worklet, not a ScriptProcessor). */
  | 'audio_worklet_unsupported'

export type VoiceAudioSupport =
  | { ok: true }
  | { ok: false; reason: VoiceAudioSupportFailure }

/** The AudioContext constructor, including the legacy WebKit prefix. */
export const getAudioContextConstructor = (): typeof AudioContext | null => {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

/**
 * Captures at 16 kHz through an `AudioWorkletNode`, so a WebView without
 * `audioWorklet` cannot run capture even though playback would work.
 */
const supportsAudioWorklet = (): boolean =>
  typeof globalThis.AudioWorkletNode === 'function' &&
  typeof globalThis.AudioContext === 'function'

/**
 * Fail loud and early: probe before the transport, the tool bridge, and the
 * microphone prompt, so a host that cannot do this never opens a WebSocket.
 */
export const probeVoiceAudioSupport = (): VoiceAudioSupport => {
  const mediaDevices = (
    globalThis as unknown as {
      navigator?: { mediaDevices?: { getUserMedia?: unknown } }
    }
  ).navigator?.mediaDevices
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function')
    return { ok: false, reason: 'insecure_context' }
  if (!getAudioContextConstructor())
    return { ok: false, reason: 'audio_context_unsupported' }
  if (!supportsAudioWorklet())
    return { ok: false, reason: 'audio_worklet_unsupported' }
  return { ok: true }
}

/** A capture failure that deserves its own message rather than a generic one. */
export type VoiceMicFailure =
  /** `getUserMedia` refused: the app's RECORD_AUDIO grant was not given. */
  | 'mic_permission_denied'
  /** The context would not leave `suspended` — no user activation, or the OS. */
  | 'audio_suspended'
  /** Any other capture failure (no device, hardware in use, …). */
  | 'mic_unavailable'

export class VoiceAudioError extends Error {
  readonly failure: VoiceMicFailure
  /** The DOM exception behind this failure, when there was one. */
  readonly source: unknown

  constructor(failure: VoiceMicFailure, message: string, source?: unknown) {
    super(message)
    this.name = 'VoiceAudioError'
    this.failure = failure
    this.source = source
  }
}

/**
 * `getUserMedia` reports a refused grant as `NotAllowedError` on Chromium
 * WebViews and `SecurityError` on older ones; both mean "permission", which is a
 * different user action from "no microphone".
 */
const isPermissionRefusal = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/** Wraps a `getUserMedia` rejection in a named, user-actionable failure. */
export const toVoiceMicError = (error: unknown): VoiceAudioError => {
  const detail = error instanceof Error ? error.message : String(error)
  return new VoiceAudioError(
    isPermissionRefusal(error) ? 'mic_permission_denied' : 'mic_unavailable',
    detail,
    error,
  )
}

/**
 * Enter the `running` state, or fail loudly.
 *
 * A WebView creates a context `suspended` when it is not created inside a user
 * gesture, and `resume()` resolves without effect when the document has no
 * activation — the session would then report "Listening" while capturing and
 * playing nothing. Chrome uses *sticky* activation per document, so a start
 * issued from the user's mic tap is unlockable even after `await` boundaries.
 */
export const unlockAudioContext = async (
  context: AudioContext,
): Promise<void> => {
  // Read through a call so TypeScript does not carry the `running` exclusion
  // from the guard below across `resume()`, which mutates the state.
  const state = (): AudioContextState => context.state
  if (state() === 'running') return
  try {
    await context.resume()
  } catch (error) {
    throw new VoiceAudioError(
      'audio_suspended',
      error instanceof Error ? error.message : String(error),
      error,
    )
  }
  const settled = state()
  if (settled !== 'running')
    throw new VoiceAudioError(
      'audio_suspended',
      `AudioContext stayed ${settled}`,
    )
}
