import { GeminiLiveClient, type WebSocketLike } from './GeminiLiveClient'
import { GeminiLiveSession, type VoiceTurn } from './GeminiLiveSession'
import { buildLiveWebSocketUrl } from './geminiLiveProtocol'
import { LiveAudioPlayer } from './audio/LiveAudioPlayer'
import { PcmMicCapture } from './audio/PcmMicCapture'
import { voiceSessionStore } from './voiceSessionStore'
import type { ResolvedLiveConnection } from './resolveLiveConnection'

export type CreateGeminiLiveRuntimeOptions = {
  connection: ResolvedLiveConnection
  onTurn: (turn: VoiceTurn) => void
  createSocket: (url: string) => WebSocketLike
}

export const createGeminiLiveRuntime = (options: CreateGeminiLiveRuntimeOptions) => {
  let session: GeminiLiveSession
  const client = new GeminiLiveClient({
    url: buildLiveWebSocketUrl({
      baseUrl: options.connection.baseUrl,
      apiKey: options.connection.apiKey,
    }),
    setupConfig: {
      model: options.connection.model,
      voiceName: options.connection.voiceName,
      systemPrompt: options.connection.systemPrompt,
    },
    createSocket: options.createSocket,
    onEvent: (event) => session.handleEvent(event),
  })

  const microphone = new PcmMicCapture({
    onFrame: (dataBase64) => client.sendAudio(dataBase64),
    onLevel: (level) => voiceSessionStore.setMicLevel(level),
  })
  const player = new LiveAudioPlayer()

  session = new GeminiLiveSession({
    client,
    microphone,
    player,
    store: voiceSessionStore,
    onTurn: options.onTurn,
  })

  return {
    session,
    start: () => session.start(),
    stop: () => session.stop(),
    sendText: (text: string) => session.sendText(text),
    setMuted: (muted: boolean) => session.setMuted(muted),
  }
}

export { voiceSessionStore, VoiceSessionStore } from './voiceSessionStore'
export { resolveLiveConnection } from './resolveLiveConnection'
export type { VoiceTurn } from './GeminiLiveSession'
export type { ResolvedLiveConnection } from './resolveLiveConnection'
export type { VoiceSessionSnapshot, VoiceSessionStatus } from './voiceSessionStore'
