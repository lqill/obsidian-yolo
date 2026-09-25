import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type { VoiceLiveTurn, VoicePartialTextKind } from '../../core/realtime'
import { voiceSessionStore } from '../../core/realtime/voiceSessionStore'

import type { StreamingContentSource } from './useAssistantRenderStream'

const getLiveTurn = (): VoiceLiveTurn | null =>
  voiceSessionStore.getSnapshot().liveTurn

/** Module-level so `useSyncExternalStore` sees a stable identity across renders. */
const getNoLiveTurn = (): VoiceLiveTurn | null => null
const getNoText = (): string => ''

/**
 * The voice turn currently being spoken, or null outside a live turn. The
 * bubbles read it to decide whether a message they are rendering is the one the
 * transcript is streaming into.
 */
export function useVoiceLiveTurn(): VoiceLiveTurn | null {
  return useSyncExternalStore(
    voiceSessionStore.subscribe,
    getLiveTurn,
    getNoLiveTurn,
  )
}

/**
 * One role's live transcript. Subscribes to the partial text alone — the
 * mic-level meter writes to the same store at frame cadence and must not wake
 * a text consumer.
 */
function useVoicePartialText(kind: VoicePartialTextKind): string {
  const subscribe = useCallback(
    (listener: () => void) =>
      voiceSessionStore.subscribePartialText(kind, listener),
    [kind],
  )
  const getSnapshot = useCallback(
    () => voiceSessionStore.getPartialText(kind),
    [kind],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getNoText)
}

/** The spoken text of the live user message, or null when it is not live. */
export function useVoiceLiveUserText(messageId: string): string | null {
  const liveTurn = useVoiceLiveTurn()
  const text = useVoicePartialText('user')
  return liveTurn?.userMessageId === messageId ? text : null
}

/**
 * The live assistant content, shaped like the agent's streamed content so the
 * bubble can hand it to `StreamingMarkdown`'s imperative playout. Null unless
 * this message is the one the model is currently speaking into.
 */
export function useVoiceLiveAssistantContent({
  conversationId,
  messageId,
}: {
  conversationId: string
  messageId: string
}): { content: string; contentSource: StreamingContentSource } | null {
  const liveTurn = useVoiceLiveTurn()
  const content = useVoicePartialText('assistant')
  const contentSource = useMemo<StreamingContentSource>(
    () => ({
      getContent: () => voiceSessionStore.getPartialText('assistant'),
      subscribe: (listener) =>
        voiceSessionStore.subscribePartialText('assistant', listener),
    }),
    [],
  )

  const isLive =
    liveTurn !== null &&
    liveTurn.conversationId === conversationId &&
    liveTurn.assistantMessageId === messageId
  return isLive ? { content, contentSource } : null
}
