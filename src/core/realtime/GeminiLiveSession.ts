// src/core/realtime/GeminiLiveSession.ts
import type { GeminiLiveClientEvent } from './GeminiLiveClient'
import type {
  GeminiLiveFunctionCall,
  GeminiLiveFunctionResponse,
  GeminiLiveHistoryTurn,
} from './geminiLiveProtocol'
import { normalizeVoiceHistoryTurns } from './voiceHistory'
import type { VoiceSessionStore } from './voiceSessionStore'

export type VoiceTurn = { userText: string; assistantText: string }

export type VoiceMicrophone = {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
}

export type VoiceAudioPlayer = {
  enqueue(dataBase64: string): void
  flush(): void
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
  ) => Promise<GeminiLiveFunctionResponse[]>
  /** Prior turns replayed on `setupComplete` so a restarted session keeps context. */
  initialHistory?: GeminiLiveHistoryTurn[]
}

type VoiceTurnState = 'idle' | 'open' | 'committed'

export class GeminiLiveSession {
  private turnState: VoiceTurnState = 'idle'
  private typedText = ''
  private spokenUserText = ''
  private assistantText = ''
  private stopped = false
  // Serializes tool-call batches: the Live API can push a second `toolCall`
  // frame while the first batch is still executing, and running them
  // concurrently would let the later batch overwrite the active-tool chip and
  // send responses out of request order.
  private toolCallChain: Promise<void> = Promise.resolve()
  private readonly history: GeminiLiveHistoryTurn[]

  constructor(private readonly options: GeminiLiveSessionOptions) {
    this.history = normalizeVoiceHistoryTurns(options.initialHistory ?? [])
  }

  async start(): Promise<void> {
    this.stopped = false
    this.options.store.setStatus('connecting')
    // With history, capture waits for `ready`: the server must receive the
    // seeded `clientContent` before any realtime input reaches the session.
    if (this.history.length === 0) await this.options.microphone.start()
    this.options.client.connect()
  }

  stop(): void {
    this.stopped = true
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
   * Opens the turn, discarding the previous turn's accumulated text if it
   * already committed, and signals a first open so the caller can create the
   * turn's messages before any of its text reaches the screen.
   */
  private beginTurn(): void {
    const opensTurn = this.turnState !== 'open'
    if (this.turnState === 'committed') {
      this.typedText = ''
      this.spokenUserText = ''
      this.assistantText = ''
      this.options.store.clearPartialUser()
    }
    this.turnState = 'open'
    if (opensTurn) this.options.onTurnOpen?.()
  }

  /**
   * Replays the saved turns as `clientContent` (the server withholds the
   * realtime conversation until `turnComplete`), then opens the microphone.
   */
  private async replayInitialHistory(): Promise<void> {
    if (this.stopped || this.history.length === 0) return
    this.options.client.sendInitialHistory(this.history)
    try {
      await this.options.microphone.start()
    } catch (error) {
      if (this.stopped) return
      this.options.store.setStatus('error', {
        failure: 'mic_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      })
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
      const responses = await this.options.toolHandler(calls)
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
    if (this.turnState !== 'open') return
    const spoken = this.spokenUserText.trim()
    const userText = [this.typedText.trim(), spoken].filter(Boolean).join('\n')
    const assistantText = this.assistantText.trim()
    this.turnState = 'committed'
    this.typedText = ''
    this.spokenUserText = ''
    this.assistantText = ''
    this.options.store.clearPartialUser()
    this.options.store.setActiveTool(null)
    if (!userText && !assistantText) return
    this.options.onTurn({ userText, assistantText })
  }
}
