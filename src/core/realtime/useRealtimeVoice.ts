// src/core/realtime/useRealtimeVoice.ts
import { useSyncExternalStore } from 'react'

import type {
  VoiceSessionSnapshot,
  VoiceStatusSnapshot,
} from './voiceSessionStore'
import { voiceSessionStore } from './voiceSessionStore'

const IDLE_STATUS: VoiceStatusSnapshot = {
  status: 'idle',
  isActive: false,
  muted: false,
  activeToolName: null,
  error: null,
  liveTurn: null,
}

const getNoText = (): string => ''

/**
 * Module-level so `useSyncExternalStore` sees a stable identity across renders.
 */
const subscribeUserText = (listener: () => void): (() => void) =>
  voiceSessionStore.subscribePartialUser(listener)
const getUserText = (): string => voiceSessionStore.getPartialUserText()

/**
 * Whether a session is live, plus the facts the chat surface reads from it
 * (mic button state, the pickers' lock, the error line, which messages the
 * transcript streams into). Subscribes to the coarse channel: the mic meter
 * and transcript deltas write to the same store at frame cadence and must not
 * re-render the chat tree.
 */
export function useRealtimeVoiceStatus(): VoiceStatusSnapshot {
  return useSyncExternalStore(
    voiceSessionStore.subscribeStatus,
    voiceSessionStore.getStatusSnapshot,
    () => IDLE_STATUS,
  )
}

/** The whole snapshot, meter included — the control bar renders the level. */
export function useRealtimeVoiceSnapshot(): VoiceSessionSnapshot {
  return useSyncExternalStore(
    voiceSessionStore.subscribe,
    voiceSessionStore.getSnapshot,
    voiceSessionStore.getSnapshot,
  )
}

/**
 * The spoken text of one message, or null when it is not the live user turn.
 * The text arrives delta by delta on its own channel; the turn it belongs to
 * comes from the coarse one, so neither the meter nor another message's
 * deltas wake this consumer.
 */
export function useRealtimeUserText(messageId: string): string | null {
  const { liveTurn } = useRealtimeVoiceStatus()
  const text = useSyncExternalStore(subscribeUserText, getUserText, getNoText)
  return liveTurn?.userMessageId === messageId ? text : null
}
