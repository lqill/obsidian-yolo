import {
  GeminiLiveClient,
  type GeminiLiveClientEvent,
  type WebSocketLike,
} from './GeminiLiveClient'

class FakeWebSocket implements WebSocketLike {
  readyState = 1
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  constructor(public readonly url: string) {}
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }
}

describe('GeminiLiveClient', () => {
  const make = () => {
    const sockets: FakeWebSocket[] = []
    const events: GeminiLiveClientEvent[] = []
    const client = new GeminiLiveClient({
      url: 'wss://x',
      createSocket: (url) => {
        const s = new FakeWebSocket(url)
        sockets.push(s)
        return s
      },
      setupConfig: {
        model: 'models/m',
        voiceName: 'Kore',
        systemPrompt: 'sys',
      },
      onEvent: (e) => events.push(e),
    })
    return { client, sockets, events }
  }

  it('sends the setup frame on open', () => {
    const { client, sockets } = make()
    client.connect()
    sockets[0].onopen?.({})
    expect(JSON.parse(sockets[0].sent[0]).setup.model).toBe('models/m')
  })

  it('forwards parsed server events and emits closed', () => {
    const { client, sockets, events } = make()
    client.connect()
    sockets[0].onopen?.({})
    sockets[0].onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    sockets[0].onclose?.({ code: 1001, reason: 'bye' })
    expect(events).toContainEqual({ kind: 'ready' })
    expect(events).toContainEqual({ kind: 'closed', code: 1001, reason: 'bye' })
  })

  it('sends audio and text as encoded frames', () => {
    const { client, sockets } = make()
    client.connect()
    sockets[0].onopen?.({})
    client.sendText('hi')
    client.sendAudio('AAAA')
    client.sendAudioStreamEnd()
    const sent = sockets[0].sent
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
})
