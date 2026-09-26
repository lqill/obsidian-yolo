import { createGeminiLiveRuntime } from './index'

jest.mock('./audio/PcmMicCapture', () => ({
  PcmMicCapture: class {
    start = jest.fn(async () => {})
    stop = jest.fn()
    setMuted = jest.fn()
  },
}))

jest.mock('./audio/LiveAudioPlayer', () => ({
  LiveAudioPlayer: class {
    enqueue = jest.fn()
    flush = jest.fn()
    dispose = jest.fn()
  },
}))

/** Stands in for the renderer's WebSocket; installed as the global. */
class FakeSocket {
  static instances: FakeSocket[] = []

  readyState = 1
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }
}

const connection = {
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'k',
  model: 'gemini-3.1-flash-live-preview',
  voiceName: 'Kore',
  systemPrompt: '',
}

describe('createGeminiLiveRuntime', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  })

  it('returns a session plus a stop function without touching browser globals', () => {
    const runtime = createGeminiLiveRuntime({
      connection,
      onTurn: () => {},
    })
    expect(typeof runtime.start).toBe('function')
    expect(typeof runtime.stop).toBe('function')
    runtime.stop()
  })

  it('advertises tool declarations from the bridge in the setup frame', async () => {
    const declarations = [
      {
        name: 'fs_read',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const runtime = createGeminiLiveRuntime({
      connection,
      onTurn: () => {},
      toolBridge: {
        declarations,
        handleFunctionCalls: async () => [],
      },
    })
    await runtime.start()
    const socket = FakeSocket.instances[0]
    socket.onopen?.({})
    expect(JSON.parse(socket.sent[0]).setup.tools).toEqual([
      { functionDeclarations: declarations },
    ])
    runtime.stop()
  })

  it('drops whitespace-only turns, and the setup flag follows', async () => {
    const runtime = createGeminiLiveRuntime({
      connection,
      onTurn: () => {},
      initialHistory: [
        { role: 'user', text: '   ' },
        { role: 'user', text: 'real question' },
      ],
    })
    await runtime.start()
    const socket = FakeSocket.instances[0]
    socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    // The flag and the replayed frame come from the same normalized list.
    expect(JSON.parse(socket.sent[0]).setup.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    })
    expect(JSON.parse(socket.sent[1]).clientContent.turns).toEqual([
      { role: 'user', parts: [{ text: 'real question' }] },
    ])
    runtime.stop()
  })

  it('asks for no history handshake when every turn is blank', async () => {
    const runtime = createGeminiLiveRuntime({
      connection,
      onTurn: () => {},
      initialHistory: [{ role: 'user', text: '   ' }],
    })
    await runtime.start()
    const socket = FakeSocket.instances[0]
    socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    expect(JSON.parse(socket.sent[0]).setup.historyConfig).toBeUndefined()
    expect(socket.sent).toHaveLength(1)
    runtime.stop()
  })

  it('seeds the setup frame with history and replays it on setupComplete', async () => {
    const runtime = createGeminiLiveRuntime({
      connection,
      onTurn: () => {},
      initialHistory: [
        { role: 'user', text: 'earlier question' },
        { role: 'model', text: 'earlier answer' },
      ],
    })
    await runtime.start()
    const socket = FakeSocket.instances[0]
    socket.onopen?.({})
    expect(JSON.parse(socket.sent[0]).setup.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    })
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    expect(JSON.parse(socket.sent[1])).toEqual({
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: 'earlier question' }] },
          { role: 'model', parts: [{ text: 'earlier answer' }] },
        ],
        turnComplete: true,
      },
    })
    runtime.stop()
  })
})
