import { useCallback, useEffect, useMemo, useRef } from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import type {
  RealtimeVoiceAssistantStream,
  VoiceLiveTurn,
  VoiceTurn,
} from '../../core/realtime'
import { probeVoiceAudioSupport } from '../../core/realtime/audio/voiceAudioSupport'
import {
  endRealtimeVoiceSession,
  failRealtimeVoiceSession,
  getRealtimeVoiceStatus,
  markRealtimeVoiceConnecting,
  setRealtimeVoiceLiveTurn,
} from '../../core/realtime/sessionControl'
import type {
  VoiceToolBridge,
  VoiceToolConversationPort,
} from '../../core/realtime/voiceToolBridge'
import type { ChatUserMessage } from '../../types/chat'
import { getNodeDocument } from '../../utils/dom/window-context'

import type { ChatSessionController } from './ChatSessionController'
import { awaitVoiceToolCallResolution } from './voiceToolCallResolution'
import {
  buildFinalTurnMessages,
  buildLiveTurnMessages,
  createVoiceLiveTurn,
} from './voiceTurnMessages'

export const useVoiceSession = ({
  sessionController,
  conversationId,
  liveModelId,
  assistantStream,
  stampTimeContext,
  resolveToolBridge,
  surfaceElement,
}: {
  sessionController: ChatSessionController
  conversationId: string
  liveModelId: string
  /** Where the spoken transcript streams — see `RealtimeVoiceAssistantStream`. */
  assistantStream: RealtimeVoiceAssistantStream
  stampTimeContext?: (message: ChatUserMessage) => ChatUserMessage
  resolveToolBridge?: (
    conversationPort: VoiceToolConversationPort,
  ) => Promise<VoiceToolBridge | null>
  /**
   * The chat view's own root node. Its `ownerDocument` is the window this
   * surface lives in, which is where `visibilitychange` must be observed — the
   * global `document` is the main window's, so a popout would never be told it
   * went to the background.
   */
  surfaceElement?: HTMLElement | null
}) => {
  const { settings } = useSettings()
  const plugin = usePlugin()
  const runtimeRef = useRef<{
    start(): Promise<void>
    stop(): void
    sendText(t: string): void
    setMuted(m: boolean): void
    setForeground(foreground: boolean): Promise<void>
  } | null>(null)
  const pinnedConversationRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  /** The turn being spoken right now; null between turns. */
  const liveTurnRef = useRef<VoiceLiveTurn | null>(null)
  /** Tool messages written into the current turn, so `stop` can drop them with it. */
  const turnToolMessageIdsRef = useRef<Set<string>>(new Set())

  /**
   * The bridge's one seam into the chat surface. A voice tool call is written
   * into the conversation (so the timeline shows it and any approval card is
   * actionable), and a call parked for approval is awaited from the same
   * conversation — the surface that resolves it does not know the bridge exists.
   */
  const toolConversationPort = useMemo<VoiceToolConversationPort>(() => {
    const agentService = plugin.getAgentService()
    return {
      publish: (message) => {
        const pinnedConversationId = pinnedConversationRef.current
        if (!pinnedConversationId) return
        turnToolMessageIdsRef.current.add(message.id)
        sessionController.upsertConversationMessages({
          conversationId: pinnedConversationId,
          messages: [
            {
              ...message,
              metadata: { ...message.metadata, realtimeVoice: true },
            },
          ],
          // Part of the live turn: durable only once the turn commits, exactly
          // like the turn's own messages. See `commitTurn`.
          persist: false,
        })
      },
      awaitResolution: (toolCallIds, signal) =>
        awaitVoiceToolCallResolution({
          agentService,
          conversationId: pinnedConversationRef.current ?? conversationId,
          toolCallIds,
          signal,
        }),
    }
  }, [conversationId, plugin, sessionController])

  /**
   * A turn opens on its first transcript delta. Put its messages into the
   * conversation immediately — still textless, and not yet durable — so the
   * bubbles exist and the store's partial transcript has somewhere to stream
   * into.
   */
  const openTurn = useCallback(() => {
    const conversationId = pinnedConversationRef.current
    if (!conversationId) return
    const liveTurn = createVoiceLiveTurn(conversationId)
    liveTurnRef.current = liveTurn
    turnToolMessageIdsRef.current = new Set()
    setRealtimeVoiceLiveTurn(liveTurn)
    assistantStream.begin(conversationId, liveTurn.assistantMessageId)
    sessionController.upsertConversationMessages({
      conversationId,
      messages: buildLiveTurnMessages({
        liveTurn,
        liveModelId,
        model: settings.chatModels.find((m) => m.id === liveModelId),
      }),
      persist: false,
    })
  }, [assistantStream, liveModelId, sessionController, settings.chatModels])

  /**
   * Feeds the spoken text into the conversation's render stream, so the bubble
   * plays it out exactly like an agent reply.
   */
  const publishAssistantText = useCallback(
    (text: string) => {
      const liveTurn = liveTurnRef.current
      if (!liveTurn) return
      assistantStream.publish({
        conversationId: liveTurn.conversationId,
        messageId: liveTurn.assistantMessageId,
        content: text,
      })
    },
    [assistantStream],
  )

  /**
   * Finalizes the live turn in place: the messages that streamed become the
   * persisted messages, same ids, so nothing remounts and no text is re-typed.
   * The stream is released first, so the write that follows settles it at the
   * committed text.
   */
  const commitTurn = useCallback(
    (turn: VoiceTurn) => {
      const liveTurn = liveTurnRef.current
      liveTurnRef.current = null
      setRealtimeVoiceLiveTurn(null)
      if (!liveTurn) return
      assistantStream.end(liveTurn.conversationId, liveTurn.assistantMessageId)
      sessionController.upsertConversationMessages({
        conversationId: liveTurn.conversationId,
        messages: buildFinalTurnMessages({
          liveTurn,
          turn,
          liveModelId,
          model: settings.chatModels.find((m) => m.id === liveModelId),
          stampTimeContext,
        }),
      })
    },
    [
      assistantStream,
      liveModelId,
      sessionController,
      settings.chatModels,
      stampTimeContext,
    ],
  )

  const start = useCallback(async () => {
    if (startingRef.current) return
    const currentStatus = getRealtimeVoiceStatus()
    if (currentStatus !== 'idle' && currentStatus !== 'error') return
    // Capability, not platform: the Live transport, the tool bridge, and the
    // conversation write-back are all platform-free, and Obsidian's Android app
    // is a WebView that runs the whole path once the audio stack is unlocked. A
    // `Platform.isDesktop` gate would hide the feature on the hosts that can
    // actually use it, so the probe names the real obstacle instead.
    const support = probeVoiceAudioSupport()
    if (!support.ok) {
      failRealtimeVoiceSession({ failure: support.reason })
      return
    }
    startingRef.current = true
    markRealtimeVoiceConnecting()
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
        failRealtimeVoiceSession({ failure: resolution.reason })
        return
      }
      pinnedConversationRef.current = conversationId
      let toolBridge: VoiceToolBridge | null = null
      try {
        toolBridge = (await resolveToolBridge?.(toolConversationPort)) ?? null
      } catch (error) {
        // Fail loud: a session started without its resolved tools would silently
        // diverge from the text agent's surface.
        failRealtimeVoiceSession({
          failure: 'tools_unavailable',
          detail: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (!toolBridge) {
        // The bridge also carries the shared system prompt, so failing here
        // fails loud rather than letting the live model speak from a different
        // config than the chat model.
        failRealtimeVoiceSession({ failure: 'tools_unavailable' })
        return
      }
      const runtime = createGeminiLiveRuntime({
        connection: resolution.value,
        systemPrompt: toolBridge.systemPrompt,
        onTurn: commitTurn,
        onTurnOpen: openTurn,
        onAssistantText: publishAssistantText,
        toolBridge,
        initialHistory: buildVoiceHistoryTurns(
          sessionController.getSnapshot().chatMessages,
        ),
      })
      runtimeRef.current = runtime
      await runtime.start()
    } catch (error) {
      // A named audio failure (`mic_permission_denied`, `audio_suspended`, …) is
      // already in the store with its actionable reason; overwriting it with the
      // generic one would throw that away.
      if (getRealtimeVoiceStatus() !== 'error')
        failRealtimeVoiceSession({
          failure: 'start_failed',
          detail: error instanceof Error ? error.message : String(error),
        })
    } finally {
      startingRef.current = false
    }
  }, [
    settings,
    conversationId,
    commitTurn,
    openTurn,
    publishAssistantText,
    resolveToolBridge,
    sessionController,
    toolConversationPort,
  ])

  const stop = useCallback(() => {
    runtimeRef.current?.stop()
    runtimeRef.current = null
    const liveTurn = liveTurnRef.current
    liveTurnRef.current = null
    const turnToolMessageIds = [...turnToolMessageIdsRef.current]
    turnToolMessageIdsRef.current = new Set()
    pinnedConversationRef.current = null
    if (liveTurn) {
      // The turn never committed: drop the messages it was streaming into —
      // including any tool card it opened — matching the pre-live behaviour of
      // persisting nothing until `turnComplete`.
      assistantStream.end(liveTurn.conversationId, liveTurn.assistantMessageId)
      sessionController.upsertConversationMessages({
        conversationId: liveTurn.conversationId,
        removeMessageIds: [
          liveTurn.userMessageId,
          liveTurn.assistantMessageId,
          ...turnToolMessageIds,
        ],
      })
    }
    endRealtimeVoiceSession()
  }, [assistantStream, sessionController])

  /**
   * Reconnects the live session in place. The server keeps its own turn history
   * for the life of a session and offers no way to retract a turn, so after the
   * user undoes one the only way to make the model forget it is a new session
   * whose `initialHistory` is rebuilt from the cleaned transcript.
   */
  const restart = useCallback(() => {
    // A start still in flight builds its history from the transcript only after
    // its awaits, so it already picks up the post-undo state — nothing to
    // reconnect. An established session is the one whose server-side history
    // has to be rebuilt.
    if (!pinnedConversationRef.current || !runtimeRef.current) return
    stop()
    void start()
  }, [start, stop])

  useEffect(() => {
    const pinned = pinnedConversationRef.current
    if (pinned && pinned !== conversationId) stop()
  }, [conversationId, stop])

  /**
   * Follows this surface's window. On Android, backgrounding the app suspends
   * the WebView's audio hardware while the socket stays open: without this the
   * control bar keeps claiming to listen, the microphone indicator stays lit,
   * and every frame is decoded into a dead context.
   */
  useEffect(() => {
    if (!surfaceElement) return
    const ownerDocument = getNodeDocument(surfaceElement)
    const handleVisibilityChange = () => {
      const runtime = runtimeRef.current
      if (!runtime) return
      void runtime.setForeground(ownerDocument.visibilityState === 'visible')
    }
    ownerDocument.addEventListener('visibilitychange', handleVisibilityChange)
    return () =>
      ownerDocument.removeEventListener(
        'visibilitychange',
        handleVisibilityChange,
      )
  }, [surfaceElement])

  /**
   * Releases the microphone, the audio graph, and the socket when the view goes
   * away. Deliberately does not touch the conversation: this cleanup can run
   * after `Chat.tsx` has disposed the session controller, and the live turn's
   * messages were never durable anyway (`persist: false`).
   *
   * Guarded on this hook owning the runtime, because the store is a singleton
   * shared across windows — a second window's view unmounting must not end the
   * session this one started.
   */
  useEffect(
    () => () => {
      if (!runtimeRef.current) return
      runtimeRef.current.stop()
      runtimeRef.current = null
      liveTurnRef.current = null
      turnToolMessageIdsRef.current = new Set()
      pinnedConversationRef.current = null
      endRealtimeVoiceSession()
    },
    [],
  )

  const sendText = useCallback(
    (text: string) => runtimeRef.current?.sendText(text),
    [],
  )
  const setMuted = useCallback(
    (muted: boolean) => runtimeRef.current?.setMuted(muted),
    [],
  )

  return { start, stop, restart, sendText, setMuted }
}
