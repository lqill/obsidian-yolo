import {
  type GeminiLiveFunctionResponse,
  type GeminiLiveHistoryTurn,
  type GeminiLiveServerEvent,
  type GeminiLiveSetupConfig,
  buildAudioMessage,
  buildAudioStreamEndMessage,
  buildClientContentHistoryMessage,
  buildSetupMessage,
  buildTextMessage,
  buildToolResponseMessage,
  parseServerMessage,
} from './geminiLiveProtocol'

export type GeminiLiveClientEvent =
  | GeminiLiveServerEvent
  | { kind: 'closed'; code: number; reason: string }

export type GeminiLiveClientOptions = {
  url: string
  setupConfig: GeminiLiveSetupConfig
  onEvent: (event: GeminiLiveClientEvent) => void
}

const OPEN = 1

export class GeminiLiveClient {
  private socket: WebSocket | null = null
  private readonly setupMessage: string

  constructor(private readonly options: GeminiLiveClientOptions) {
    this.setupMessage = JSON.stringify(buildSetupMessage(options.setupConfig))
  }

  connect(): void {
    if (this.socket) return
    // The Gemini Live API is served over WSS only, and the browser's own
    // WebSocket is the one transport available in the renderer.
    const socket = new WebSocket(this.options.url)
    this.socket = socket
    socket.onopen = () => socket.send(this.setupMessage)
    socket.onmessage = (event) => {
      void this.handleMessage(event.data)
    }
    socket.onerror = () => {
      this.options.onEvent({ kind: 'error', message: 'WebSocket error' })
    }
    socket.onclose = (event) => {
      this.socket = null
      this.options.onEvent({
        kind: 'closed',
        code: event.code,
        reason: event.reason,
      })
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string
    if (typeof data === 'string') {
      text = data
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data))
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      text = await data.text()
    } else {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    for (const event of parseServerMessage(parsed)) this.options.onEvent(event)
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === OPEN)
      this.socket.send(JSON.stringify(message))
  }

  sendText(text: string): void {
    this.send(buildTextMessage(text))
  }

  sendInitialHistory(turns: GeminiLiveHistoryTurn[]): void {
    this.send(buildClientContentHistoryMessage(turns))
  }

  sendAudio(dataBase64: string): void {
    this.send(buildAudioMessage(dataBase64))
  }

  sendAudioStreamEnd(): void {
    this.send(buildAudioStreamEndMessage())
  }

  sendToolResponse(functionResponses: GeminiLiveFunctionResponse[]): void {
    this.send(buildToolResponseMessage(functionResponses))
  }

  close(): void {
    this.socket?.close(1000, 'client-close')
    this.socket = null
  }
}
