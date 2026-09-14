// src/core/realtime/geminiLiveProtocol.ts

export const BUILD_LIVE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
export const LIVE_INPUT_SAMPLE_RATE = 16000
export const LIVE_OUTPUT_SAMPLE_RATE = 24000

const LIVE_WS_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export type GeminiLiveFunctionCall = {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export type GeminiLiveServerEvent =
  | { kind: 'ready' }
  | { kind: 'audio'; dataBase64: string; mimeType: string }
  | { kind: 'inputTranscript'; text: string }
  | { kind: 'outputTranscript'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'turnComplete' }
  | { kind: 'toolCall'; functionCalls: GeminiLiveFunctionCall[] }
  | { kind: 'error'; message: string; raw?: unknown }

export type GeminiLiveSetupConfig = {
  model: string
  voiceName: string
  systemPrompt: string
}

export type GeminiLiveClientMessage = Record<string, unknown>

export const normalizeLiveModelName = (model: string): string =>
  model.startsWith('models/') ? model : `models/${model}`

/** Builds the Live WSS URL; refuses non-default base URLs (proxies do not serve the Live path). */
export const buildLiveWebSocketUrl = ({
  baseUrl,
  apiKey,
}: {
  baseUrl: string
  apiKey: string
}): string => {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized !== BUILD_LIVE_DEFAULT_BASE_URL) {
    throw new Error(
      'Voice mode requires the default Gemini base URL; custom base URLs / proxies are not supported by the Live API.',
    )
  }
  return `wss://generativelanguage.googleapis.com${LIVE_WS_PATH}?key=${encodeURIComponent(apiKey)}`
}

export const buildSetupMessage = (config: GeminiLiveSetupConfig): GeminiLiveClientMessage => ({
  setup: {
    model: normalizeLiveModelName(config.model),
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } },
      },
    },
    systemInstruction: { parts: [{ text: config.systemPrompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
})

export const buildAudioMessage = (dataBase64: string): GeminiLiveClientMessage => ({
  realtimeInput: { audio: { data: dataBase64, mimeType: 'audio/pcm;rate=16000' } },
})

export const buildTextMessage = (text: string): GeminiLiveClientMessage => ({
  realtimeInput: { text },
})

export const buildAudioStreamEndMessage = (): GeminiLiveClientMessage => ({
  realtimeInput: { audioStreamEnd: true },
})

export const buildToolResponseMessage = (
  functionResponses: Array<{ id?: string; name: string; response: unknown }>,
): GeminiLiveClientMessage => ({ toolResponse: { functionResponses } })

export const encodeClientMessage = (message: GeminiLiveClientMessage): string =>
  JSON.stringify(message)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/** Pure parser: server frame -> zero or more normalized events. */
export const parseServerMessage = (raw: unknown): GeminiLiveServerEvent[] => {
  const root = asRecord(raw)
  if (!root) return []
  const events: GeminiLiveServerEvent[] = []

  if (root.setupComplete) events.push({ kind: 'ready' })

  const content = asRecord(root.serverContent)
  if (content) {
    const modelTurn = asRecord(content.modelTurn)
    const parts = Array.isArray(modelTurn?.parts) ? (modelTurn!.parts as unknown[]) : []
    for (const part of parts) {
      const inline = asRecord(asRecord(part)?.inlineData)
      const data = inline?.data
      if (typeof data === 'string') {
        events.push({
          kind: 'audio',
          dataBase64: data,
          mimeType: typeof inline?.mimeType === 'string' ? inline.mimeType : 'audio/pcm',
        })
      }
    }
    const input = asRecord(content.inputTranscription)
    if (typeof input?.text === 'string' && input.text.length > 0) {
      events.push({ kind: 'inputTranscript', text: input.text })
    }
    const output = asRecord(content.outputTranscription)
    if (typeof output?.text === 'string' && output.text.length > 0) {
      events.push({ kind: 'outputTranscript', text: output.text })
    }
    if (content.interrupted === true) events.push({ kind: 'interrupted' })
    if (content.turnComplete === true) events.push({ kind: 'turnComplete' })
  }

  const toolCall = asRecord(root.toolCall)
  const calls = Array.isArray(toolCall?.functionCalls) ? (toolCall!.functionCalls as unknown[]) : []
  if (calls.length > 0) {
    events.push({
      kind: 'toolCall',
      functionCalls: calls.map((call) => {
        const record = asRecord(call) ?? {}
        return {
          id: typeof record.id === 'string' ? record.id : undefined,
          name: typeof record.name === 'string' ? record.name : 'unknown',
          args: asRecord(record.args) ?? undefined,
        }
      }),
    })
  }

  const error = asRecord(root.error)
  if (error) {
    events.push({
      kind: 'error',
      message: typeof error.message === 'string' ? error.message : 'Unknown Live API error',
      raw: error,
    })
  }

  return events
}
