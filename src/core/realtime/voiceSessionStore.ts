// src/core/realtime/voiceSessionStore.ts
import type { LiveConnectionFailure } from './resolveLiveConnection'

export type VoiceSessionStatus = 'idle' | 'connecting' | 'ready' | 'error'

export type VoicePartialTextKind = 'user' | 'assistant'

/**
 * Why a voice session failed. Core names the failure; the UI owns the wording,
 * so the store never carries a user-visible string of our own. `detail` holds
 * text we did not write (the server's message, a DOM exception).
 */
export type VoiceFailure =
  | LiveConnectionFailure
  | 'mic_unavailable'
  | 'server'
  | 'session_closed'
  | 'tools_unavailable'
  | 'start_failed'

export type VoiceError = Readonly<{
  failure: VoiceFailure
  detail?: string
}>

/**
 * The conversation messages of the turn currently being spoken. The turn's
 * messages exist in the conversation from the first transcript delta (so the
 * bubbles mount and stream) and are finalized in place on `turnComplete`, so
 * this is only the mapping the bubbles use to find their own live text.
 */
export type VoiceLiveTurn = {
  conversationId: string
  userMessageId: string
  assistantMessageId: string
}

export type VoiceSessionSnapshot = {
  status: VoiceSessionStatus
  muted: boolean
  micLevel: number
  partialUserText: string
  partialAssistantText: string
  liveTurn: VoiceLiveTurn | null
  error: VoiceError | null
  activeToolName: string | null
  conversationId: string | null
}

const IDLE: VoiceSessionSnapshot = {
  status: 'idle',
  muted: false,
  micLevel: 0,
  partialUserText: '',
  partialAssistantText: '',
  liveTurn: null,
  error: null,
  activeToolName: null,
  conversationId: null,
}

/**
 * Module-level singleton. Popouts share the plugin JS realm, so one store
 * coordinates the single-session lock across windows without touching main.ts.
 * Transient only — never conversation state.
 */
export class VoiceSessionStore {
  private snapshot: VoiceSessionSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  /**
   * Partial transcripts get their own listeners: the mic-level meter writes to
   * the same store at frame cadence, and a subscriber that only cares about the
   * text must not be woken (or re-render) for level updates.
   */
  private readonly partialListeners: Record<
    VoicePartialTextKind,
    Set<() => void>
  > = { user: new Set(), assistant: new Set() }

  getSnapshot = (): VoiceSessionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The live text of one role; '' outside a live turn. */
  getPartialText = (kind: VoicePartialTextKind): string =>
    kind === 'user'
      ? this.snapshot.partialUserText
      : this.snapshot.partialAssistantText

  subscribePartialText = (
    kind: VoicePartialTextKind,
    listener: () => void,
  ): (() => void) => {
    const listeners = this.partialListeners[kind]
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  private set(patch: Partial<VoiceSessionSnapshot>): void {
    const previous = this.snapshot
    this.snapshot = { ...previous, ...patch }
    if (this.snapshot.partialUserText !== previous.partialUserText) {
      for (const listener of [...this.partialListeners.user]) listener()
    }
    if (this.snapshot.partialAssistantText !== previous.partialAssistantText) {
      for (const listener of [...this.partialListeners.assistant]) listener()
    }
    for (const listener of this.listeners) listener()
  }

  setStatus = (
    status: VoiceSessionStatus,
    error: VoiceError | null = null,
  ): void => this.set({ status, error })

  setConversationId = (conversationId: string | null): void =>
    this.set({ conversationId })

  setMuted = (muted: boolean): void => this.set({ muted })

  setMicLevel = (micLevel: number): void => this.set({ micLevel })

  setActiveTool = (activeToolName: string | null): void =>
    this.set({ activeToolName })

  setLiveTurn = (liveTurn: VoiceLiveTurn | null): void => this.set({ liveTurn })

  appendPartialUser = (text: string): void =>
    this.set({ partialUserText: this.snapshot.partialUserText + text })

  appendPartialAssistant = (text: string): void =>
    this.set({
      partialAssistantText: this.snapshot.partialAssistantText + text,
    })

  clearPartials = (): void =>
    this.set({ partialUserText: '', partialAssistantText: '' })

  reset = (): void => this.set({ ...IDLE })
}

export const voiceSessionStore = new VoiceSessionStore()
