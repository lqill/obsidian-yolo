// src/core/realtime/GeminiLiveSession.ts
import type { GeminiLiveClientEvent } from './GeminiLiveClient'
import type {
  GeminiLiveFunctionCall,
  GeminiLiveFunctionResponse,
} from './geminiLiveProtocol'
import type { VoiceSessionStore } from './voiceSessionStore'

export type VoiceTurn = { userText: string; assistantText: string }

export type VoiceMicrophone = {
  start(
    onFrame: (dataBase64: string) => void,
    onLevel: (level: number) => void,
  ): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
}

export type VoiceAudioPlayer = {
  enqueue(dataBase64: string, mimeType: string): void
  flush(): void
  dispose(): void
}

export type VoiceLiveClient = {
  connect(): void
  close(): void
  sendText(text: string): void
  sendAudio(dataBase64: string): void
  sendAudioStreamEnd(): void
  sendToolResponse(functionResponses: GeminiLiveFunctionResponse[]): void
  isOpen: boolean
}

export type GeminiLiveSessionOptions = {
  client: VoiceLiveClient
  microphone: VoiceMicrophone
  player: VoiceAudioPlayer
  store: VoiceSessionStore
  onTurn: (turn: VoiceTurn) => void
  toolHandler?: (
    calls: GeminiLiveFunctionCall[],
  ) => Promise<GeminiLiveFunctionResponse[]>
}

export class GeminiLiveSession {
  private turnActive = false
  private turnDone = false
  private typedText = ''
  private spokenUserText = ''
  private assistantText = ''
  private stopped = false
  // Serializes tool-call batches: the Live API can push a second `toolCall`
  // frame while the first batch is still executing, and running them
  // concurrently would let the later batch overwrite the active-tool chip and
  // send responses out of request order.
  private toolCallChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: GeminiLiveSessionOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    this.options.store.setStatus('connecting')
    await this.options.microphone.start(
      (dataBase64) => this.options.client.sendAudio(dataBase64),
      (level) => this.options.store.setMicLevel(level),
    )
    this.options.client.connect()
  }

  stop(): void {
    this.stopped = true
    this.options.client.sendAudioStreamEnd()
    this.options.microphone.stop()
    this.options.player.flush()
    this.options.client.close()
    this.options.player.dispose()
    this.options.store.setActiveTool(null)
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
    this.markTurnActive()
    this.typedText = this.typedText ? `${this.typedText}\n${trimmed}` : trimmed
    this.options.store.appendPartialUser(`${trimmed}\n`)
    this.options.client.sendText(trimmed)
  }

  private markTurnActive(): void {
    if (this.turnDone) {
      this.turnActive = false
      this.turnDone = false
      this.typedText = ''
      this.spokenUserText = ''
      this.assistantText = ''
      this.options.store.clearPartials()
    }
    this.turnActive = true
  }

  handleEvent(event: GeminiLiveClientEvent): void {
    if (this.stopped) return
    switch (event.kind) {
      case 'ready':
        this.options.store.setStatus('ready')
        break
      case 'audio':
        this.options.player.enqueue(event.dataBase64, event.mimeType)
        break
      case 'inputTranscript':
        this.markTurnActive()
        this.spokenUserText += event.text
        this.options.store.appendPartialUser(event.text)
        break
      case 'outputTranscript':
        this.markTurnActive()
        this.assistantText += event.text
        this.options.store.appendPartialAssistant(event.text)
        break
      case 'interrupted':
        this.options.player.flush()
        this.commitTurn()
        break
      case 'turnComplete':
        this.commitTurn()
        break
      case 'error':
        this.options.store.setStatus('error', event.message)
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
        this.options.store.setStatus('error', event.reason || null)
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
      this.options.store.setStatus('error', message)
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
    if (!this.turnActive || this.turnDone) return
    const spoken = this.spokenUserText.trim()
    const userText = [this.typedText.trim(), spoken].filter(Boolean).join('\n')
    const assistantText = this.assistantText.trim()
    this.turnActive = false
    this.turnDone = true
    this.typedText = ''
    this.spokenUserText = ''
    this.assistantText = ''
    this.options.store.clearPartials()
    this.options.store.setActiveTool(null)
    if (!userText && !assistantText) return
    this.options.onTurn({ userText, assistantText })
  }
}
