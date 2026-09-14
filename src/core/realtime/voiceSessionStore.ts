// src/core/realtime/voiceSessionStore.ts

export type VoiceSessionStatus = 'idle' | 'connecting' | 'ready' | 'error'

export type VoiceSessionSnapshot = {
  status: VoiceSessionStatus
  muted: boolean
  micLevel: number
  partialUserText: string
  partialAssistantText: string
  error: string | null
  conversationId: string | null
}

const IDLE: VoiceSessionSnapshot = {
  status: 'idle',
  muted: false,
  micLevel: 0,
  partialUserText: '',
  partialAssistantText: '',
  error: null,
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

  getSnapshot = (): VoiceSessionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<VoiceSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  setStatus = (status: VoiceSessionStatus, error: string | null = null): void =>
    this.set({ status, error })

  setConversationId = (conversationId: string | null): void => this.set({ conversationId })

  setMuted = (muted: boolean): void => this.set({ muted })

  setMicLevel = (micLevel: number): void => this.set({ micLevel })

  appendPartialUser = (text: string): void =>
    this.set({ partialUserText: this.snapshot.partialUserText + text })

  appendPartialAssistant = (text: string): void =>
    this.set({ partialAssistantText: this.snapshot.partialAssistantText + text })

  clearPartials = (): void =>
    this.set({ partialUserText: '', partialAssistantText: '' })

  reset = (): void => this.set({ ...IDLE })
}

export const voiceSessionStore = new VoiceSessionStore()
