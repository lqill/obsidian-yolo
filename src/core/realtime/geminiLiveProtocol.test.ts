// src/core/realtime/geminiLiveProtocol.test.ts
import {
  buildAudioMessage,
  buildAudioStreamEndMessage,
  buildClientContentHistoryMessage,
  buildLiveWebSocketUrl,
  buildSetupMessage,
  buildTextMessage,
  buildToolResponseMessage,
  parseServerMessage,
} from './geminiLiveProtocol'

describe('buildLiveWebSocketUrl', () => {
  it('builds the default wss endpoint with the api key', () => {
    const url = buildLiveWebSocketUrl({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'abc',
    })
    expect(url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=abc',
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

describe('client frames', () => {
  it('names the capture rate in the audio frame', () => {
    expect(buildAudioMessage('AAAA')).toEqual({
      realtimeInput: {
        audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
      },
    })
  })

  it('serializes text and audioStreamEnd frames', () => {
    expect(buildTextMessage('hi')).toEqual({ realtimeInput: { text: 'hi' } })
    expect(buildAudioStreamEndMessage()).toEqual({
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
    expect(events).toEqual([{ kind: 'audio', dataBase64: 'AAAA' }])
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
      { kind: 'error', message: 'bad model' },
    ])
  })

  it('returns [] for empty/unknown payloads', () => {
    expect(parseServerMessage({})).toEqual([])
    expect(parseServerMessage(null)).toEqual([])
  })
})

describe('buildSetupMessage with tools', () => {
  it('omits tools when no declarations are provided', () => {
    const msg = buildSetupMessage({
      model: 'm',
      voiceName: 'Kore',
      systemPrompt: 's',
    })
    expect((msg as any).setup.tools).toBeUndefined()
  })

  it('emits a single functionDeclarations entry with the provided declarations', () => {
    const declarations = [
      {
        name: 'fs_read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    ]
    const msg = buildSetupMessage({
      model: 'm',
      voiceName: 'Kore',
      systemPrompt: 's',
      functionDeclarations: declarations,
    })
    expect((msg as any).setup.tools).toEqual([
      { functionDeclarations: declarations },
    ])
  })
})

describe('buildToolResponseMessage', () => {
  it('wraps function responses in a toolResponse envelope', () => {
    expect(
      buildToolResponseMessage([
        { id: '1', name: 'fs_read', response: { result: 'ok' } },
      ]),
    ).toEqual({
      toolResponse: {
        functionResponses: [
          { id: '1', name: 'fs_read', response: { result: 'ok' } },
        ],
      },
    })
  })
})

describe('buildSetupMessage with initial history', () => {
  it('omits historyConfig unless client-content history is requested', () => {
    const msg = buildSetupMessage({
      model: 'm',
      voiceName: 'Kore',
      systemPrompt: 's',
    })
    expect((msg as any).setup.historyConfig).toBeUndefined()
  })

  it('waits for clientContent history when requested', () => {
    const msg = buildSetupMessage({
      model: 'm',
      voiceName: 'Kore',
      systemPrompt: 's',
      initialHistoryInClientContent: true,
    })
    expect((msg as any).setup.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    })
  })
})

describe('buildClientContentHistoryMessage', () => {
  it('maps turns to content parts and marks the history complete', () => {
    expect(
      buildClientContentHistoryMessage([
        { role: 'user', text: 'hi' },
        { role: 'model', text: 'hello' },
      ]),
    ).toEqual({
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ text: 'hello' }] },
        ],
        turnComplete: true,
      },
    })
  })
})
