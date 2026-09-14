import { createGeminiLiveRuntime } from './index'

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
})
