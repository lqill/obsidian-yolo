// src/core/realtime/geminiLiveProtocol.ts
import { GeminiProvider } from '../llm/gemini'

export const LIVE_INPUT_SAMPLE_RATE = 16000
export const LIVE_OUTPUT_SAMPLE_RATE = 24000

const LIVE_WS_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export type GeminiLiveFunctionCall = {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export type GeminiLiveFunctionDeclaration = {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export type GeminiLiveFunctionResponse = {
  id?: string
  name: string
  response: Record<string, unknown>
}

/** A prior conversation turn replayed into a fresh session as initial history. */
export type GeminiLiveHistoryTurn = {
  role: 'user' | 'model'
  text: string
}

export type GeminiLiveServerEvent =
  | { kind: 'ready' }
  | { kind: 'audio'; dataBase64: string }
  | { kind: 'inputTranscript'; text: string }
  | { kind: 'outputTranscript'; text: string }
  | { kind: 'interrupted' }
  | { kind: 'turnComplete' }
  | { kind: 'toolCall'; functionCalls: GeminiLiveFunctionCall[] }
  | { kind: 'error'; message: string }

export type GeminiLiveSetupConfig = {
  model: string
  voiceName: string
  systemPrompt: string
  functionDeclarations?: GeminiLiveFunctionDeclaration[]
  /**
   * When set, the server waits for `clientContent` history turns (ending in
   * `turnComplete: true`) before the realtime conversation starts. Required
   * for the seeded-history frame to be treated as context rather than a prompt.
   */
  initialHistoryInClientContent?: boolean
}

export type GeminiLiveClientMessage = Record<string, unknown>

/**
 * Builds the Live WSS URL. `baseUrl` is expected to be the resolved Gemini
 * endpoint (`resolveLiveConnection` refuses anything else), so only its host is
 * needed here.
 */
export const buildLiveWebSocketUrl = ({
  baseUrl,
  apiKey,
}: {
  baseUrl: string
  apiKey: string
}): string => {
  const host = new URL(baseUrl).host
  return `wss://${host}${LIVE_WS_PATH}?key=${encodeURIComponent(apiKey)}`
}

export const buildSetupMessage = (
  config: GeminiLiveSetupConfig,
): GeminiLiveClientMessage => {
  const setup: Record<string, unknown> = {
    model: GeminiProvider.normalizeModelPath(config.model),
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voiceName } },
      },
    },
    systemInstruction: { parts: [{ text: config.systemPrompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  }
  if (config.functionDeclarations && config.functionDeclarations.length > 0) {
    setup.tools = [{ functionDeclarations: config.functionDeclarations }]
  }
  if (config.initialHistoryInClientContent) {
    setup.historyConfig = { initialHistoryInClientContent: true }
  }
  return { setup }
}

/** Replays prior turns as initial history so a new session does not start blank. */
export const buildClientContentHistoryMessage = (
  turns: GeminiLiveHistoryTurn[],
): GeminiLiveClientMessage => ({
  clientContent: {
    turns: turns.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
    turnComplete: true,
  },
})

export const buildAudioMessage = (
  dataBase64: string,
): GeminiLiveClientMessage => ({
  realtimeInput: {
    audio: {
      data: dataBase64,
      // The same rate the capture runs at, so the declared and actual rates
      // cannot drift apart.
      mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
    },
  },
})

export const buildTextMessage = (text: string): GeminiLiveClientMessage => ({
  realtimeInput: { text },
})

export const buildAudioStreamEndMessage = (): GeminiLiveClientMessage => ({
  realtimeInput: { audioStreamEnd: true },
})

export const buildToolResponseMessage = (
  functionResponses: GeminiLiveFunctionResponse[],
): GeminiLiveClientMessage => ({ toolResponse: { functionResponses } })

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null

/** Pure parser: server frame -> zero or more normalized events. */
export const parseServerMessage = (raw: unknown): GeminiLiveServerEvent[] => {
  const root = asRecord(raw)
  if (!root) return []
  const events: GeminiLiveServerEvent[] = []

  if (root.setupComplete) events.push({ kind: 'ready' })

  const content = asRecord(root.serverContent)
  if (content) {
    const modelTurn = asRecord(content.modelTurn)
    const parts = Array.isArray(modelTurn?.parts)
      ? (modelTurn.parts as unknown[])
      : []
    for (const part of parts) {
      const inline = asRecord(asRecord(part)?.inlineData)
      const data = inline?.data
      if (typeof data === 'string') {
        events.push({ kind: 'audio', dataBase64: data })
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
  const calls = Array.isArray(toolCall?.functionCalls)
    ? (toolCall.functionCalls as unknown[])
    : []
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
      message:
        typeof error.message === 'string'
          ? error.message
          : 'Unknown Live API error',
    })
  }

  return events
}
