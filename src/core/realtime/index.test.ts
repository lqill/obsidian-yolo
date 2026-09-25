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

describe('createGeminiLiveRuntime', () => {
  it('returns a session plus a stop function without touching browser globals', () => {
    const runtime = createGeminiLiveRuntime({
      connection: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
        model: 'gemini-3.1-flash-live-preview',
        voiceName: 'Kore',
        systemPrompt: '',
      },
      onTurn: () => {},
      createSocket: () => ({
        readyState: 1,
        send: () => {},
        close: () => {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      }),
    })
    expect(typeof runtime.start).toBe('function')
    expect(typeof runtime.stop).toBe('function')
    runtime.stop()
  })

  it('advertises tool declarations from the bridge in the setup frame', async () => {
    // Collected in an array: a bare `let socket` is control-flow narrowed to
    // `null` at the use site because the assignment happens inside the
    // `createSocket` callback.
    const sockets: Array<{ onopen: ((ev: unknown) => void) | null }> = []
    const sent: string[] = []
    const declarations = [
      {
        name: 'fs_read',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const runtime = createGeminiLiveRuntime({
      connection: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
        model: 'gemini-3.1-flash-live-preview',
        voiceName: 'Kore',
        systemPrompt: '',
      },
      onTurn: () => {},
      createSocket: () => {
        const fake = {
          readyState: 1,
          send: (data: string) => sent.push(data),
          close: () => {},
          onopen: null as ((ev: unknown) => void) | null,
          onmessage: null,
          onerror: null,
          onclose: null,
        }
        sockets.push(fake)
        return fake
      },
      toolBridge: {
        declarations,
        handleFunctionCalls: async () => [],
      },
    })
    await runtime.start()
    sockets[0]?.onopen?.({})
    expect(JSON.parse(sent[0]).setup.tools).toEqual([
      { functionDeclarations: declarations },
    ])
    runtime.stop()
  })

  it('seeds the setup frame with history and replays it on setupComplete', async () => {
    const sockets: Array<{
      onopen: ((ev: unknown) => void) | null
      onmessage: ((ev: { data: unknown }) => void) | null
    }> = []
    const sent: string[] = []
    const runtime = createGeminiLiveRuntime({
      connection: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
        model: 'gemini-3.1-flash-live-preview',
        voiceName: 'Kore',
        systemPrompt: '',
      },
      onTurn: () => {},
      initialHistory: [
        { role: 'user', text: 'earlier question' },
        { role: 'model', text: 'earlier answer' },
      ],
      createSocket: () => {
        const fake = {
          readyState: 1,
          send: (data: string) => sent.push(data),
          close: () => {},
          onopen: null as ((ev: unknown) => void) | null,
          onmessage: null as ((ev: { data: unknown }) => void) | null,
          onerror: null,
          onclose: null,
        }
        sockets.push(fake)
        return fake
      },
    })
    await runtime.start()
    sockets[0]?.onopen?.({})
    expect(JSON.parse(sent[0]).setup.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    })
    sockets[0]?.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) })
    expect(JSON.parse(sent[1])).toEqual({
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
