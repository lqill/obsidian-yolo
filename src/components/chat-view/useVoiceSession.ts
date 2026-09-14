import { useCallback, useRef } from 'react'
import { Platform } from 'obsidian'
import { useSettings } from '../../contexts/settings-context'
import { voiceSessionStore } from '../../core/realtime/voiceSessionStore'
import type { VoiceTurn } from '../../core/realtime'
import type { ChatSessionController } from './ChatSessionController'
import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'

const buildId = () => `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const useVoiceSession = ({
  sessionController,
  conversationId,
  liveModelId,
  onVoiceActiveChange,
  stampTimeContext,
}: {
  sessionController: ChatSessionController
  conversationId: string
  liveModelId: string
  onVoiceActiveChange: (active: boolean) => void
  stampTimeContext?: (message: ChatUserMessage) => void
}) => {
  const { settings } = useSettings()
  const runtimeRef = useRef<{
    start(): Promise<void>
    stop(): void
    sendText(t: string): void
    setMuted(m: boolean): void
  } | null>(null)
  const pinnedConversationRef = useRef<string | null>(null)

  const commitTurn = useCallback(
    (turn: VoiceTurn) => {
      const pinned = pinnedConversationRef.current
      if (!pinned) return
      const userMessage: ChatUserMessage = {
        role: 'user',
        id: buildId(),
        content: null,
        promptContent: turn.userText,
        mentionables: [],
        selectedModelIds: [liveModelId],
      }
      stampTimeContext?.(userMessage)
      const assistantMessage: ChatAssistantMessage = {
        role: 'assistant',
        id: buildId(),
        content: turn.assistantText,
        metadata: {
          generationState: 'completed',
          model: settings.chatModels.find((m) => m.id === liveModelId),
        },
      }
      sessionController.appendConversationMessages(pinned, [userMessage, assistantMessage])
      voiceSessionStore.clearPartials()
    },
    [sessionController, liveModelId, settings.chatModels, stampTimeContext],
  )

  const start = useCallback(async () => {
    if (voiceSessionStore.getSnapshot().status !== 'idle') return
    if (!Platform.isDesktop) return
    const [{ resolveLiveConnection }, { createGeminiLiveRuntime }] = await Promise.all([
      import('../../core/realtime/resolveLiveConnection'),
      import('../../core/realtime'),
    ])
    const resolution = resolveLiveConnection({ settings })
    if (!resolution.ok) {
      voiceSessionStore.setStatus('error', resolution.error)
      return
    }
    pinnedConversationRef.current = conversationId
    voiceSessionStore.setConversationId(conversationId)
    onVoiceActiveChange(true)
    const runtime = createGeminiLiveRuntime({
      connection: resolution.value,
      onTurn: commitTurn,
      createSocket: (url) => new WebSocket(url),
    })
    runtimeRef.current = runtime
    await runtime.start()
  }, [settings, conversationId, commitTurn, onVoiceActiveChange])

  const stop = useCallback(() => {
    runtimeRef.current?.stop()
    runtimeRef.current = null
    pinnedConversationRef.current = null
    onVoiceActiveChange(false)
  }, [onVoiceActiveChange])

  const sendText = useCallback((text: string) => runtimeRef.current?.sendText(text), [])
  const setMuted = useCallback((muted: boolean) => runtimeRef.current?.setMuted(muted), [])

  return { start, stop, sendText, setMuted }
}
