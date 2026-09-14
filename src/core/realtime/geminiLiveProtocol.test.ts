// src/core/realtime/geminiLiveProtocol.test.ts
import {
  BUILD_LIVE_DEFAULT_BASE_URL,
  buildAudioStreamEndMessage,
  buildLiveWebSocketUrl,
  buildSetupMessage,
  buildTextMessage,
  encodeClientMessage,
  normalizeLiveModelName,
  parseServerMessage,
} from './geminiLiveProtocol'

describe('buildLiveWebSocketUrl', () => {
  it('builds the default wss endpoint with the api key', () => {
    const url = buildLiveWebSocketUrl({
      baseUrl: BUILD_LIVE_DEFAULT_BASE_URL,
      apiKey: 'abc',
    })
    expect(url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=abc',
    )
  })

  it('rejects a non-default base URL', () => {
    expect(() =>
      buildLiveWebSocketUrl({
        baseUrl: 'https://proxy.example.com',
        apiKey: 'abc',
      }),
    ).toThrow(/Live API/)
  })
})

describe('normalizeLiveModelName', () => {
  it('adds the models/ prefix once', () => {
    expect(normalizeLiveModelName('gemini-3.1-flash-live-preview')).toBe(
      'models/gemini-3.1-flash-live-preview',
    )
    expect(normalizeLiveModelName('models/gemini-3.1-flash-live-preview')).toBe(
      'models/gemini-3.1-flash-live-preview',
    )
  })
})

describe('buildSetupMessage', () => {
  it('enables both transcriptions at setup level and nests speech config', () => {
    const msg = buildSetupMessage({
      model: 'gemini-3.1-flash-live-preview',
      voiceName: 'Kore',
      systemPrompt: 'Be brief.',
    })
    const setup = (msg as any).setup
    expect(setup.model).toBe('models/gemini-3.1-flash-live-preview')
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO'])
    expect(
      setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
        .voiceName,
    ).toBe('Kore')
    expect(setup.inputAudioTranscription).toEqual({})
    expect(setup.outputAudioTranscription).toEqual({})
    expect(setup.systemInstruction.parts[0].text).toBe('Be brief.')
  })
})

describe('encodeClientMessage', () => {
  it('serializes text and audioStreamEnd frames', () => {
    expect(JSON.parse(encodeClientMessage(buildTextMessage('hi')))).toEqual({
      realtimeInput: { text: 'hi' },
    })
    expect(
      JSON.parse(encodeClientMessage(buildAudioStreamEndMessage())),
    ).toEqual({
      realtimeInput: { audioStreamEnd: true },
    })
  })
})

describe('parseServerMessage', () => {
  it('parses setupComplete', () => {
    expect(parseServerMessage({ setupComplete: {} })).toEqual([
      { kind: 'ready' },
    ])
  })

  it('parses model audio inlineData', () => {
    const events = parseServerMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    })
    expect(events).toEqual([
      { kind: 'audio', dataBase64: 'AAAA', mimeType: 'audio/pcm;rate=24000' },
    ])
  })

  it('parses input/output transcription and turn signals', () => {
    expect(
      parseServerMessage({
        serverContent: { inputTranscription: { text: 'hello' } },
      }),
    ).toEqual([{ kind: 'inputTranscript', text: 'hello' }])
    expect(
      parseServerMessage({
        serverContent: { outputTranscription: { text: 'hi' } },
      }),
    ).toEqual([{ kind: 'outputTranscript', text: 'hi' }])
    expect(
      parseServerMessage({ serverContent: { interrupted: true } }),
    ).toEqual([{ kind: 'interrupted' }])
    expect(
      parseServerMessage({ serverContent: { turnComplete: true } }),
    ).toEqual([{ kind: 'turnComplete' }])
  })

  it('parses function calls and error frames', () => {
    expect(
      parseServerMessage({
        toolCall: { functionCalls: [{ id: '1', name: 'foo', args: {} }] },
      }),
    ).toEqual([
      { kind: 'toolCall', functionCalls: [{ id: '1', name: 'foo', args: {} }] },
    ])
    expect(parseServerMessage({ error: { message: 'bad model' } })).toEqual([
      { kind: 'error', message: 'bad model', raw: { message: 'bad model' } },
    ])
  })

  it('returns [] for empty/unknown payloads', () => {
    expect(parseServerMessage({})).toEqual([])
    expect(parseServerMessage(null)).toEqual([])
  })
})
