import { LiveAudioPlayer } from './audio/LiveAudioPlayer'
import { PcmMicCapture } from './audio/PcmMicCapture'
import { GeminiLiveClient, type WebSocketLike } from './GeminiLiveClient'
import { buildLiveWebSocketUrl } from './geminiLiveProtocol'
import { GeminiLiveSession, type VoiceTurn } from './GeminiLiveSession'
import type { ResolvedLiveConnection } from './resolveLiveConnection'
import { voiceSessionStore } from './voiceSessionStore'
import type { VoiceToolBridge } from './voiceToolBridge'

export type CreateGeminiLiveRuntimeOptions = {
  connection: ResolvedLiveConnection
  onTurn: (turn: VoiceTurn) => void
  createSocket: (url: string) => WebSocketLike
  toolBridge?: VoiceToolBridge
}

export const createGeminiLiveRuntime = (
  options: CreateGeminiLiveRuntimeOptions,
): GeminiLiveSession => {
  // eslint-disable-next-line prefer-const -- declared before the client so the onEvent closure can reference it
  let session: GeminiLiveSession
  const toolBridge = options.toolBridge
  const client = new GeminiLiveClient({
    url: buildLiveWebSocketUrl({
      baseUrl: options.connection.baseUrl,
      apiKey: options.connection.apiKey,
    }),
    setupConfig: {
      model: options.connection.model,
      voiceName: options.connection.voiceName,
      systemPrompt: options.connection.systemPrompt,
      functionDeclarations: toolBridge?.declarations ?? [],
    },
    createSocket: options.createSocket,
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
    toolHandler: toolBridge
      ? (calls) => toolBridge.handleFunctionCalls(calls)
      : undefined,
  })

  return session
}

export { voiceSessionStore, VoiceSessionStore } from './voiceSessionStore'
export { resolveLiveConnection } from './resolveLiveConnection'
export type { VoiceTurn } from './GeminiLiveSession'
export type { ResolvedLiveConnection } from './resolveLiveConnection'
export type {
  VoiceSessionSnapshot,
  VoiceSessionStatus,
} from './voiceSessionStore'
export type { VoiceToolBridge } from './voiceToolBridge'
