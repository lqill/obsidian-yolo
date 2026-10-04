// src/core/realtime/useRealtimeVoice.ts
import { useSyncExternalStore } from 'react'

import type { VoiceStatusSnapshot } from './voiceSessionStore'
import { voiceSessionStore } from './voiceSessionStore'

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
    voiceSessionStore.getStatusSnapshot,
  )
}

/**
 * The live mic level and its subscription, deliberately *not* a hook. The level
 * is written once per worklet render quantum (~125+/s) and nothing in the React
 * tree needs to re-render for it, so the meter writes `data-level` onto its own
 * node from the callback. A hook here — or a hook returning the whole snapshot —
 * would put the whole chat tree back on the frame cadence.
 */
export const subscribeRealtimeMicLevel = voiceSessionStore.subscribeMicLevel
export const getRealtimeMicLevel = voiceSessionStore.getMicLevel

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
