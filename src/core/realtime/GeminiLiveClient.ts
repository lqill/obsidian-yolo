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
  encodeClientMessage,
  parseServerMessage,
} from './geminiLiveProtocol'

export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
}

export type GeminiLiveClientEvent =
  | GeminiLiveServerEvent
  | { kind: 'closed'; code: number; reason: string }

export type GeminiLiveClientOptions = {
  url: string
  setupConfig: GeminiLiveSetupConfig
  createSocket: (url: string) => WebSocketLike
  onEvent: (event: GeminiLiveClientEvent) => void
}

const OPEN = 1

export class GeminiLiveClient {
  private socket: WebSocketLike | null = null
  private readonly setupMessage: string

  constructor(private readonly options: GeminiLiveClientOptions) {
    this.setupMessage = encodeClientMessage(
      buildSetupMessage(options.setupConfig),
    )
  }

  connect(): void {
    if (this.socket) return
    const socket = this.options.createSocket(this.options.url)
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

  private send(message: string): void {
    if (this.socket && this.socket.readyState === OPEN)
      this.socket.send(message)
  }

  sendText(text: string): void {
    this.send(encodeClientMessage(buildTextMessage(text)))
  }

  sendInitialHistory(turns: GeminiLiveHistoryTurn[]): void {
    this.send(encodeClientMessage(buildClientContentHistoryMessage(turns)))
  }

  sendAudio(dataBase64: string): void {
    this.send(encodeClientMessage(buildAudioMessage(dataBase64)))
  }

  sendAudioStreamEnd(): void {
    this.send(encodeClientMessage(buildAudioStreamEndMessage()))
  }

  sendToolResponse(functionResponses: GeminiLiveFunctionResponse[]): void {
    this.send(encodeClientMessage(buildToolResponseMessage(functionResponses)))
  }

  close(): void {
    this.socket?.close(1000, 'client-close')
    this.socket = null
  }
}
