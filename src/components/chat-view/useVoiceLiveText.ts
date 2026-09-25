import { useMemo, useSyncExternalStore } from 'react'

import { useRealtimeVoiceStatus } from '../../core/realtime'
import { voiceSessionStore } from '../../core/realtime/voiceSessionStore'

import type { StreamingContentSource } from './useAssistantRenderStream'

/** Module-level so `useSyncExternalStore` sees a stable identity across renders. */
const subscribeAssistantText = (listener: () => void): (() => void) =>
  voiceSessionStore.subscribePartialText('assistant', listener)
const getAssistantText = (): string =>
  voiceSessionStore.getPartialText('assistant')
const getNoText = (): string => ''

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
  const { liveTurn } = useRealtimeVoiceStatus()
  const content = useSyncExternalStore(
    subscribeAssistantText,
    getAssistantText,
    getNoText,
  )
  const contentSource = useMemo<StreamingContentSource>(
    () => ({
      getContent: getAssistantText,
      subscribe: subscribeAssistantText,
    }),
    [],
  )

  const isLive =
    liveTurn !== null &&
    liveTurn.conversationId === conversationId &&
    liveTurn.assistantMessageId === messageId
  return isLive ? { content, contentSource } : null
}
