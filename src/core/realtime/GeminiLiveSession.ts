// src/core/realtime/GeminiLiveSession.ts
import {
  VoiceAudioError,
  type VoiceMicFailure,
} from './audio/voiceAudioSupport'
import type { GeminiLiveClientEvent } from './GeminiLiveClient'
import type {
  GeminiLiveFunctionCall,
  GeminiLiveFunctionResponse,
  GeminiLiveHistoryTurn,
} from './geminiLiveProtocol'
import type { VoiceSessionStore } from './voiceSessionStore'

export type VoiceTurn = { userText: string; assistantText: string }

export type VoiceMicrophone = {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
  /** Release the OS microphone and suspend the graph; reversible. */
  suspend(): Promise<void>
  /** Re-acquire the microphone after `suspend`; rejects with a named reason. */
  resume(): Promise<void>
}

export type VoiceAudioPlayer = {
  /**
   * Create and unlock the output context while the start still has the user's
   * activation — playback must not depend on a lazily created context.
   */
  prepare(): Promise<void>
  enqueue(dataBase64: string): void
  flush(): void
  /** Suspend output and drop queued frames; reversible. */
  pause(): Promise<void>
  resume(): Promise<void>
  dispose(): void
}

export type VoiceLiveClient = {
  connect(): void
  close(): void
  sendText(text: string): void
  sendAudio(dataBase64: string): void
  sendAudioStreamEnd(): void
  sendInitialHistory(turns: GeminiLiveHistoryTurn[]): void
  sendToolResponse(functionResponses: GeminiLiveFunctionResponse[]): void
}

export type GeminiLiveSessionOptions = {
  client: VoiceLiveClient
  microphone: VoiceMicrophone
  player: VoiceAudioPlayer
  store: VoiceSessionStore
  onTurn: (turn: VoiceTurn) => void
  /**
   * The assistant's spoken text so far, as it arrives. The conversation's own
   * render stream carries it to the bubble, so this is a display channel only —
   * the committed text still comes from `onTurn`.
   */
  onAssistantText?: (text: string) => void
  /**
   * Fired once when a turn opens, before its first transcript delta reaches the
   * store. The caller uses it to put the turn's (still textless) messages into
   * the conversation so the bubbles can stream into them.
   */
  onTurnOpen?: () => void
  toolHandler?: (
    calls: GeminiLiveFunctionCall[],
    signal?: AbortSignal,
  ) => Promise<GeminiLiveFunctionResponse[]>
  /** Prior turns replayed on `setupComplete`; already normalized by the caller. */
  initialHistory?: GeminiLiveHistoryTurn[]
}

/** A named audio failure, or the generic one for anything unexpected. */
const toVoiceFailure = (
  error: unknown,
): { failure: VoiceMicFailure; detail: string } => {
  if (error instanceof VoiceAudioError)
    return { failure: error.failure, detail: error.message }
  return {
    failure: 'mic_unavailable',
    detail: error instanceof Error ? error.message : String(error),
  }
}

export class GeminiLiveSession {
  private turnOpen = false
  private typedText = ''
  private spokenUserText = ''
  private assistantText = ''
  private stopped = false
  /** Mirrors the host's foreground state; `true` means audio is live. */
  private foreground = true
  // Serializes tool-call batches: the Live API can push a second `toolCall`
  // frame while the first batch is still executing, and running them
  // concurrently would let the later batch overwrite the active-tool chip and
  // send responses out of request order.
  private toolCallChain: Promise<void> = Promise.resolve()
  /**
   * Aborts a tool batch that is still waiting on the user when the session
   * stops, so a pending approval card cannot outlive the turn that produced it.
   */
  private toolAbortController = new AbortController()

  constructor(private readonly options: GeminiLiveSessionOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    this.foreground = true
    this.toolAbortController = new AbortController()
    this.options.store.setStatus('connecting')
    // Unlock output while the start still carries the user's activation: a
    // WebView context created later (on the first server frame) would stay
    // suspended and the session would be silent.
    await this.runAudioStep(() => this.options.player.prepare())
    // With history, capture waits for `ready`: the server must receive the
    // seeded `clientContent` before any realtime input reaches the session.
    if ((this.options.initialHistory?.length ?? 0) === 0) {
      await this.runAudioStep(() => this.options.microphone.start())
    }
    this.options.client.connect()
  }

  /**
   * Runs an audio step and, on failure, puts the actionable reason in the store
   * before rethrowing — so the caller that reports `start_failed` cannot bury a
   * `mic_permission_denied` or an `audio_suspended` under a generic one.
   */
  private async runAudioStep(step: () => Promise<void>): Promise<void> {
    try {
      await step()
    } catch (error) {
      const { failure, detail } = toVoiceFailure(error)
      this.options.store.setStatus('error', { failure, detail })
      throw error
    }
  }

  /**
   * Follows the host's foreground state. Backgrounding the WebView suspends its
   * audio hardware while the socket stays open, so a backgrounded session would
   * keep claiming to listen while capturing and playing nothing (and would hold
   * the Android microphone indicator on). Foregrounding re-acquires the
   * microphone and unlocks output, or fails loudly — the user re-taps the mic if
   * the grant is gone.
   */
  async setForeground(foreground: boolean): Promise<void> {
    if (this.stopped || foreground === this.foreground) return
    this.foreground = foreground
    try {
      if (foreground)
        await this.runAudioStep(async () => {
          await this.options.microphone.resume()
          await this.options.player.resume()
        })
      else
        await this.runAudioStep(async () => {
          this.options.client.sendAudioStreamEnd()
          this.options.player.flush()
          await this.options.player.pause()
          await this.options.microphone.suspend()
        })
    } catch {
      // `runAudioStep` already put the reason in the store.
      return
    }
    if (this.stopped) return
    this.options.store.setStatus(foreground ? 'ready' : 'paused')
  }

  stop(): void {
    this.stopped = true
    this.toolAbortController.abort()
    this.options.client.sendAudioStreamEnd()
    this.options.microphone.stop()
    this.options.player.flush()
    this.options.client.close()
    this.options.player.dispose()
    this.options.store.reset()
  }

  setMuted(muted: boolean): void {
    this.options.microphone.setMuted(muted)
    this.options.store.setMuted(muted)
    if (muted) this.options.client.sendAudioStreamEnd()
  }

  sendText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.beginTurn()
    this.typedText = this.typedText ? `${this.typedText}\n${trimmed}` : trimmed
    this.options.store.appendPartialUser(`${trimmed}\n`)
    this.options.client.sendText(trimmed)
  }

  /**
   * Opens the turn, resetting the accumulators, and signals a first open so the
   * caller can create the turn's messages before any of its text reaches the
   * screen.
   */
  private beginTurn(): void {
    if (this.turnOpen) return
    this.turnOpen = true
    this.typedText = ''
    this.spokenUserText = ''
    this.assistantText = ''
    this.options.store.clearPartialUser()
    this.options.onTurnOpen?.()
  }

  /**
   * Replays the saved turns as `clientContent` (the server withholds the
   * realtime conversation until `turnComplete`), then opens the microphone.
   */
  private async replayInitialHistory(): Promise<void> {
    const history = this.options.initialHistory ?? []
    if (this.stopped || history.length === 0) return
    this.options.client.sendInitialHistory(history)
    try {
      await this.runAudioStep(() => this.options.microphone.start())
    } catch {
      // `runAudioStep` already named the failure in the store; the socket stays
      // open so the session can still answer text input.
    }
  }

  handleEvent(event: GeminiLiveClientEvent): void {
    if (this.stopped) return
    switch (event.kind) {
      case 'ready':
        this.options.store.setStatus('ready')
        void this.replayInitialHistory()
        break
      case 'audio':
        this.options.player.enqueue(event.dataBase64)
        break
      case 'inputTranscript':
        this.beginTurn()
        this.spokenUserText += event.text
        this.options.store.appendPartialUser(event.text)
        break
      case 'outputTranscript':
        this.beginTurn()
        this.assistantText += event.text
        this.options.onAssistantText?.(this.assistantText)
        break
      case 'interrupted':
        this.options.player.flush()
        this.commitTurn()
        break
      case 'turnComplete':
        this.commitTurn()
        break
      case 'error':
        this.options.store.setStatus('error', {
          failure: 'server',
          detail: event.message,
        })
        break
      case 'toolCall':
        this.toolCallChain = this.toolCallChain
          .catch(() => undefined)
          .then(() => this.handleToolCall(event.functionCalls))
        break
      case 'closed':
        this.toolAbortController.abort()
        this.commitTurn()
        this.options.player.flush()
        this.options.microphone.stop()
        this.options.store.setStatus('error', {
          failure: 'session_closed',
          ...(event.reason ? { detail: event.reason } : {}),
        })
        break
    }
  }

  private async handleToolCall(calls: GeminiLiveFunctionCall[]): Promise<void> {
    if (this.stopped || !this.options.toolHandler || calls.length === 0) return
    this.options.store.setActiveTool(calls.map((call) => call.name).join(', '))
    try {
      const responses = await this.options.toolHandler(
        calls,
        this.toolAbortController.signal,
      )
      if (this.stopped) return
      this.options.client.sendToolResponse(responses)
    } catch (error) {
      if (this.stopped) return
      const message = error instanceof Error ? error.message : String(error)
      this.options.store.setStatus('error', {
        failure: 'tools_unavailable',
        detail: message,
      })
      // The Live API blocks until every function call has a response, so a
      // failure here must still answer each call — otherwise the session stalls
      // with no further audio even though the UI reports an error.
      this.options.client.sendToolResponse(
        calls.map((call) => ({
          id: call.id,
          name: call.name,
          response: { error: message },
        })),
      )
    } finally {
      if (!this.stopped) this.options.store.setActiveTool(null)
    }
  }

  private commitTurn(): void {
    if (!this.turnOpen) return
    const spoken = this.spokenUserText.trim()
    const userText = [this.typedText.trim(), spoken].filter(Boolean).join('\n')
    const assistantText = this.assistantText.trim()
    this.turnOpen = false
    this.typedText = ''
    this.spokenUserText = ''
    this.assistantText = ''
    this.options.store.clearPartialUser()
    this.options.store.setActiveTool(null)
    if (!userText && !assistantText) return
    this.options.onTurn({ userText, assistantText })
  }
}
