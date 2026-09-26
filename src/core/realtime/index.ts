import { LiveAudioPlayer } from './audio/LiveAudioPlayer'
import { PcmMicCapture } from './audio/PcmMicCapture'
import { GeminiLiveClient } from './GeminiLiveClient'
import {
  type GeminiLiveHistoryTurn,
  buildLiveWebSocketUrl,
} from './geminiLiveProtocol'
import { GeminiLiveSession, type VoiceTurn } from './GeminiLiveSession'
import type { ResolvedLiveConnection } from './resolveLiveConnection'
import { normalizeVoiceHistoryTurns } from './voiceHistory'
import { voiceSessionStore } from './voiceSessionStore'
import type { VoiceToolBridge } from './voiceToolBridge'

export type CreateGeminiLiveRuntimeOptions = {
  connection: ResolvedLiveConnection
  /**
   * The session's system instruction — see `VoiceToolBridge.systemPrompt`. It
   * is the chat model's assembled prompt plus the voice addendum, so the live
   * model shares the text agent's profile, memory, skills, and mode persona.
   */
  systemPrompt: string
  onTurn: (turn: VoiceTurn) => void
  /** See `GeminiLiveSessionOptions.onAssistantText`. */
  onAssistantText?: (text: string) => void
  /** Fired once per turn when it opens; see `GeminiLiveSessionOptions`. */
  onTurnOpen?: () => void
  toolBridge?: VoiceToolBridge
  /** Prior conversation turns replayed so a restarted session keeps context. */
  initialHistory?: GeminiLiveHistoryTurn[]
}

export const createGeminiLiveRuntime = (
  options: CreateGeminiLiveRuntimeOptions,
): GeminiLiveSession => {
  // eslint-disable-next-line prefer-const -- declared before the client so the onEvent closure can reference it
  let session: GeminiLiveSession
  // Local so the tool handler closure keeps the narrowing; `options.toolBridge`
  // cannot be narrowed inside it.
  const toolBridge = options.toolBridge
  const initialHistory = normalizeVoiceHistoryTurns(
    options.initialHistory ?? [],
  )
  const client = new GeminiLiveClient({
    url: buildLiveWebSocketUrl({
      baseUrl: options.connection.baseUrl,
      apiKey: options.connection.apiKey,
    }),
    setupConfig: {
      model: options.connection.model,
      voiceName: options.connection.voiceName,
      systemPrompt: options.systemPrompt,
      functionDeclarations: toolBridge?.declarations ?? [],
      initialHistoryInClientContent: initialHistory.length > 0,
    },
    onEvent: (event) => session.handleEvent(event),
  })

  session = new GeminiLiveSession({
    client,
    microphone: new PcmMicCapture({
      onFrame: (dataBase64) => client.sendAudio(dataBase64),
      onLevel: (level) => voiceSessionStore.setMicLevel(level),
    }),
    player: new LiveAudioPlayer(),
    store: voiceSessionStore,
    onTurn: options.onTurn,
    onAssistantText: options.onAssistantText,
    onTurnOpen: options.onTurnOpen,
    toolHandler: toolBridge
      ? (calls) => toolBridge.handleFunctionCalls(calls)
      : undefined,
    initialHistory,
  })

  return session
}

export { resolveLiveConnection } from './resolveLiveConnection'
export { buildVoiceHistoryTurns } from './voiceHistory'
export {
  useRealtimeUserText,
  useRealtimeVoiceSnapshot,
  useRealtimeVoiceStatus,
} from './useRealtimeVoice'
export {
  endRealtimeVoiceSession,
  failRealtimeVoiceSession,
  getRealtimeVoiceStatus,
  markRealtimeVoiceConnecting,
  setRealtimeVoiceLiveTurn,
} from './sessionControl'
export type { RealtimeVoiceAssistantStream } from './assistantStream'
export type { VoiceTurn } from './GeminiLiveSession'
export type { GeminiLiveHistoryTurn } from './geminiLiveProtocol'
export type { ResolvedLiveConnection } from './resolveLiveConnection'
export type {
  VoiceError,
  VoiceFailure,
  VoiceLiveTurn,
  VoiceSessionSnapshot,
  VoiceSessionStatus,
  VoiceStatusSnapshot,
} from './voiceSessionStore'
export type { VoiceToolBridge } from './voiceToolBridge'
