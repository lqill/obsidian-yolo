// src/core/realtime/GeminiLiveSession.ts
import type { GeminiLiveClientEvent } from './GeminiLiveClient'
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
  isOpen: boolean
}

export type GeminiLiveSessionOptions = {
  client: VoiceLiveClient
  microphone: VoiceMicrophone
  player: VoiceAudioPlayer
  store: VoiceSessionStore
  onTurn: (turn: VoiceTurn) => void
}

export class GeminiLiveSession {
  private turnActive = false
  private turnDone = false
  private typedText = ''
  private spokenUserText = ''
  private assistantText = ''

  constructor(private readonly options: GeminiLiveSessionOptions) {}

  async start(): Promise<void> {
    this.options.store.setStatus('connecting')
    await this.options.microphone.start(
      (dataBase64) => this.options.client.sendAudio(dataBase64),
      (level) => this.options.store.setMicLevel(level),
    )
    this.options.client.connect()
  }

  stop(): void {
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
      case 'closed':
        break
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
    if (!userText && !assistantText) return
    this.options.onTurn({ userText, assistantText })
  }
}
