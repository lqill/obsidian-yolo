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
    let socket: {
      onopen: ((ev: unknown) => void) | null
    } | null = null
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
        socket = fake
        return fake
      },
      toolBridge: {
        declarations,
        handleFunctionCalls: async () => [],
      },
    })
    await runtime.start()
    socket?.onopen?.({})
    expect(JSON.parse(sent[0]).setup.tools).toEqual([
      { functionDeclarations: declarations },
    ])
    runtime.stop()
  })
})
