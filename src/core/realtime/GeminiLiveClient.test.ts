import {
  GeminiLiveClient,
  type GeminiLiveClientEvent,
} from './GeminiLiveClient'

/** Stands in for the renderer's WebSocket; installed as the global. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 1
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }
}

describe('GeminiLiveClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  const make = () => {
    const events: GeminiLiveClientEvent[] = []
    const client = new GeminiLiveClient({
      url: 'wss://x',
      setupConfig: {
        model: 'models/m',
        voiceName: 'Kore',
        systemPrompt: 'sys',
      },
      onEvent: (e) => events.push(e),
    })
    client.connect()
    return { client, socket: FakeWebSocket.instances[0], events }
  }

  it('connects to the given url and sends the setup frame on open', () => {
    const { socket } = make()
    expect(socket.url).toBe('wss://x')
    socket.onopen?.({})
    expect(JSON.parse(socket.sent[0]).setup.model).toBe('models/m')
  })

  it('forwards parsed server events and emits closed', () => {
    const { socket, events } = make()
    socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    socket.onclose?.({ code: 1001, reason: 'bye' })
    expect(events).toContainEqual({ kind: 'ready' })
    expect(events).toContainEqual({ kind: 'closed', code: 1001, reason: 'bye' })
  })

  it('sends audio and text as encoded frames', () => {
    const { client, socket } = make()
    socket.onopen?.({})
    client.sendText('hi')
    client.sendAudio('AAAA')
    client.sendAudioStreamEnd()
    const sent = socket.sent
    expect(JSON.parse(sent[sent.length - 3])).toEqual({
      realtimeInput: { text: 'hi' },
    })
    expect(JSON.parse(sent[sent.length - 2])).toEqual({
      realtimeInput: {
        audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
      },
    })
    expect(JSON.parse(sent[sent.length - 1])).toEqual({
      realtimeInput: { audioStreamEnd: true },
    })
  })

  it('sends a tool response frame', () => {
    const { client, socket } = make()
    socket.onopen?.({})
    client.sendToolResponse([
      { id: '1', name: 'fs_read', response: { result: 'ok' } },
    ])
    const sent = socket.sent
    expect(JSON.parse(sent[sent.length - 1])).toEqual({
      toolResponse: {
        functionResponses: [
          { id: '1', name: 'fs_read', response: { result: 'ok' } },
        ],
      },
    })
  })

  it('sends initial history as a completed clientContent frame', () => {
    const { client, socket } = make()
    socket.onopen?.({})
    client.sendInitialHistory([
      { role: 'user', text: 'earlier question' },
      { role: 'model', text: 'earlier answer' },
    ])
    const sent = socket.sent
    expect(JSON.parse(sent[sent.length - 1])).toEqual({
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: 'earlier question' }] },
          { role: 'model', parts: [{ text: 'earlier answer' }] },
        ],
        turnComplete: true,
      },
    })
  })
})
