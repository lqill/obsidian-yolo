import { Platform } from 'obsidian'
import { useCallback, useEffect, useRef } from 'react'

import { useSettings } from '../../contexts/settings-context'
import type { VoiceLiveTurn, VoiceTurn } from '../../core/realtime'
import { voiceSessionStore } from '../../core/realtime/voiceSessionStore'
import type { VoiceToolBridge } from '../../core/realtime/voiceToolBridge'
import type { ChatUserMessage } from '../../types/chat'

import type { ChatSessionController } from './ChatSessionController'
import {
  buildFinalTurnMessages,
  buildLiveTurnMessages,
  createVoiceLiveTurn,
} from './voiceTurnMessages'

export const useVoiceSession = ({
  sessionController,
  conversationId,
  liveModelId,
  onVoiceActiveChange,
  stampTimeContext,
  resolveToolBridge,
}: {
  sessionController: ChatSessionController
  conversationId: string
  liveModelId: string
  onVoiceActiveChange: (active: boolean) => void
  stampTimeContext?: (message: ChatUserMessage) => ChatUserMessage
  resolveToolBridge?: () => Promise<VoiceToolBridge | null>
}) => {
  const { settings } = useSettings()
  const runtimeRef = useRef<{
    start(): Promise<void>
    stop(): void
    sendText(t: string): void
    setMuted(m: boolean): void
  } | null>(null)
  const pinnedConversationRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  /** The turn being spoken right now; null between turns. */
  const liveTurnRef = useRef<VoiceLiveTurn | null>(null)

  /**
   * A turn opens on its first transcript delta. Put its messages into the
   * conversation immediately — still textless — so the bubbles exist and the
   * store's partial transcript has somewhere to stream into.
   */
  const openTurn = useCallback(() => {
    const conversationId = pinnedConversationRef.current
    if (!conversationId) return
    const liveTurn = createVoiceLiveTurn(conversationId)
    liveTurnRef.current = liveTurn
    voiceSessionStore.setLiveTurn(liveTurn)
    sessionController.beginVoiceTurn(
      conversationId,
      buildLiveTurnMessages({
        liveTurn,
        liveModelId,
        model: settings.chatModels.find((m) => m.id === liveModelId),
      }),
    )
  }, [liveModelId, sessionController, settings.chatModels])

  /**
   * Finalizes the live turn in place: the messages that streamed become the
   * persisted messages, same ids, so nothing remounts and no text is re-typed.
   */
  const commitTurn = useCallback(
    (turn: VoiceTurn) => {
      const liveTurn = liveTurnRef.current
      liveTurnRef.current = null
      voiceSessionStore.setLiveTurn(null)
      if (!liveTurn) return
      sessionController.finalizeVoiceTurn(
        liveTurn.conversationId,
        buildFinalTurnMessages({
          liveTurn,
          turn,
          liveModelId,
          model: settings.chatModels.find((m) => m.id === liveModelId),
          stampTimeContext,
        }),
      )
    },
    [liveModelId, sessionController, settings.chatModels, stampTimeContext],
  )

  const start = useCallback(async () => {
    if (startingRef.current) return
    const currentStatus = voiceSessionStore.getSnapshot().status
    if (currentStatus !== 'idle' && currentStatus !== 'error') return
    if (!Platform.isDesktop) return
    startingRef.current = true
    voiceSessionStore.setStatus('connecting')
    try {
      const [
        { resolveLiveConnection },
        { buildVoiceHistoryTurns, createGeminiLiveRuntime },
      ] = await Promise.all([
        import('../../core/realtime/resolveLiveConnection'),
        import('../../core/realtime'),
      ])
      const resolution = resolveLiveConnection({ settings })
      if (!resolution.ok) {
        voiceSessionStore.setStatus('error', { failure: resolution.reason })
        onVoiceActiveChange(true)
        return
      }
      pinnedConversationRef.current = conversationId
      voiceSessionStore.setConversationId(conversationId)
      onVoiceActiveChange(true)
      let toolBridge: VoiceToolBridge | null = null
      try {
        toolBridge = (await resolveToolBridge?.()) ?? null
      } catch (error) {
        // Fail loud: a session started without its resolved tools would silently
        // diverge from the text agent's surface.
        voiceSessionStore.setStatus('error', {
          failure: 'tools_unavailable',
          detail: error instanceof Error ? error.message : String(error),
        })
        onVoiceActiveChange(true)
        return
      }
      const runtime = createGeminiLiveRuntime({
        connection: resolution.value,
        onTurn: commitTurn,
        onTurnOpen: openTurn,
        createSocket: (url) => new WebSocket(url),
        toolBridge: toolBridge ?? undefined,
        initialHistory: buildVoiceHistoryTurns(
          sessionController.getSnapshot().chatMessages,
        ),
      })
      runtimeRef.current = runtime
      await runtime.start()
    } catch (error) {
      voiceSessionStore.setStatus('error', {
        failure: 'start_failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      onVoiceActiveChange(true)
    } finally {
      startingRef.current = false
    }
  }, [
    settings,
    conversationId,
    commitTurn,
    onVoiceActiveChange,
    openTurn,
    resolveToolBridge,
    sessionController,
  ])

  const stop = useCallback(() => {
    runtimeRef.current?.stop()
    runtimeRef.current = null
    pinnedConversationRef.current = null
    const liveTurn = liveTurnRef.current
    liveTurnRef.current = null
    if (liveTurn) {
      // The turn never committed: drop the messages it was streaming into,
      // matching the pre-live behaviour of persisting nothing until
      // `turnComplete`.
      sessionController.discardVoiceTurn(liveTurn.conversationId, [
        liveTurn.userMessageId,
        liveTurn.assistantMessageId,
      ])
    }
    voiceSessionStore.reset()
    onVoiceActiveChange(false)
  }, [onVoiceActiveChange, sessionController])

  useEffect(() => {
    const pinned = pinnedConversationRef.current
    if (pinned && pinned !== conversationId) stop()
  }, [conversationId, stop])

  const sendText = useCallback(
    (text: string) => runtimeRef.current?.sendText(text),
    [],
  )
  const setMuted = useCallback(
    (muted: boolean) => runtimeRef.current?.setMuted(muted),
    [],
  )

  return { start, stop, sendText, setMuted }
}
