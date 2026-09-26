// src/core/realtime/voiceSessionStore.ts
import type { LiveConnectionFailure } from './resolveLiveConnection'

export type VoiceSessionStatus = 'idle' | 'connecting' | 'ready' | 'error'

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
  /**
   * The spoken user text of the live turn. The assistant's side of the
   * transcript is not here: it streams through the agent's own render stream
   * (`AssistantRenderStreamStore`), so both text chat and voice drive the same
   * bubble.
   */
  partialUserText: string
  liveTurn: VoiceLiveTurn | null
  error: VoiceError | null
  activeToolName: string | null
}

const IDLE: VoiceSessionSnapshot = {
  status: 'idle',
  muted: false,
  micLevel: 0,
  partialUserText: '',
  liveTurn: null,
  error: null,
  activeToolName: null,
}

/**
 * The coarse facts about a session, without the per-frame ones. Consumers that
 * only need to know whether a session is live (the chat shell, the picker
 * locks) subscribe to this: the mic meter and the transcripts write at frame
 * cadence and must not re-render the chat tree.
 */
export type VoiceStatusSnapshot = Readonly<{
  status: VoiceSessionStatus
  /** A session exists — running, starting, or showing an error. */
  isActive: boolean
  muted: boolean
  activeToolName: string | null
  error: VoiceError | null
  /** Which messages the live transcript streams into; null between turns. */
  liveTurn: VoiceLiveTurn | null
}>

const statusOf = (snapshot: VoiceSessionSnapshot): VoiceStatusSnapshot => ({
  status: snapshot.status,
  isActive: snapshot.status !== 'idle',
  muted: snapshot.muted,
  activeToolName: snapshot.activeToolName,
  error: snapshot.error,
  liveTurn: snapshot.liveTurn,
})

const isSameStatus = (
  previous: VoiceStatusSnapshot,
  next: VoiceStatusSnapshot,
): boolean =>
  previous.status === next.status &&
  previous.isActive === next.isActive &&
  previous.muted === next.muted &&
  previous.activeToolName === next.activeToolName &&
  previous.error === next.error &&
  previous.liveTurn === next.liveTurn

/**
 * Module-level singleton. Popouts share the plugin JS realm, so one store
 * coordinates the single-session lock across windows without touching main.ts.
 * Transient only — never conversation state.
 */
export class VoiceSessionStore {
  private snapshot: VoiceSessionSnapshot = IDLE
  private statusSnapshot: VoiceStatusSnapshot = statusOf(IDLE)
  private readonly listeners = new Set<() => void>()
  /**
   * The user transcript has its own listener set: the mic-level meter writes to
   * the same store at frame cadence, and a subscriber that only cares about the
   * text must not be woken (or re-render) for level updates.
   */
  private readonly userTextListeners = new Set<() => void>()
  private readonly statusListeners = new Set<() => void>()

  getSnapshot = (): VoiceSessionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Referentially stable while only frame-rate fields change. */
  getStatusSnapshot = (): VoiceStatusSnapshot => this.statusSnapshot

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** The spoken user text of the live turn; '' outside a live turn. */
  getPartialUserText = (): string => this.snapshot.partialUserText

  subscribePartialUser = (listener: () => void): (() => void) => {
    this.userTextListeners.add(listener)
    return () => {
      this.userTextListeners.delete(listener)
    }
  }

  private set(patch: Partial<VoiceSessionSnapshot>): void {
    const previous = this.snapshot
    this.snapshot = { ...previous, ...patch }
    if (this.snapshot.partialUserText !== previous.partialUserText) {
      for (const listener of [...this.userTextListeners]) listener()
    }
    const status = statusOf(this.snapshot)
    if (!isSameStatus(this.statusSnapshot, status)) {
      this.statusSnapshot = status
      for (const listener of [...this.statusListeners]) listener()
    }
    for (const listener of this.listeners) listener()
  }

  setStatus = (
    status: VoiceSessionStatus,
    error: VoiceError | null = null,
  ): void => this.set({ status, error })

  setMuted = (muted: boolean): void => this.set({ muted })

  setMicLevel = (micLevel: number): void => this.set({ micLevel })

  setActiveTool = (activeToolName: string | null): void =>
    this.set({ activeToolName })

  setLiveTurn = (liveTurn: VoiceLiveTurn | null): void => this.set({ liveTurn })

  appendPartialUser = (text: string): void =>
    this.set({ partialUserText: this.snapshot.partialUserText + text })

  clearPartialUser = (): void => this.set({ partialUserText: '' })

  reset = (): void => this.set({ ...IDLE })
}

export const voiceSessionStore = new VoiceSessionStore()
