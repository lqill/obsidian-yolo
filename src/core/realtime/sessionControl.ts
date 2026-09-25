// src/core/realtime/sessionControl.ts
import type {
  VoiceError,
  VoiceLiveTurn,
  VoiceSessionStatus,
} from './voiceSessionStore'
import { voiceSessionStore } from './voiceSessionStore'

/**
 * The lifecycle half of the module's public API. The chat-view adapter drives a
 * session through these — it never touches the store — while everything the UI
 * displays is read through the hooks in `useRealtimeVoice`. Kept import-free
 * apart from the store so the chat view can use it without pulling the
 * transport, the audio stack or the Gemini SDK into its static graph.
 */

export const getRealtimeVoiceStatus = (): VoiceSessionStatus =>
  voiceSessionStore.getSnapshot().status

/** Shown from the moment the user asks for a session, before it is resolved. */
export const markRealtimeVoiceConnecting = (): void => {
  voiceSessionStore.setStatus('connecting')
}

/** Pins the conversation the session will write its turns into. */
export const beginRealtimeVoiceSession = (conversationId: string): void => {
  voiceSessionStore.setConversationId(conversationId)
}

export const failRealtimeVoiceSession = (error: VoiceError): void => {
  voiceSessionStore.setStatus('error', error)
}

/** Which messages the current turn's transcript streams into. */
export const setRealtimeVoiceLiveTurn = (
  liveTurn: VoiceLiveTurn | null,
): void => {
  voiceSessionStore.setLiveTurn(liveTurn)
}

export const endRealtimeVoiceSession = (): void => {
  voiceSessionStore.reset()
}
