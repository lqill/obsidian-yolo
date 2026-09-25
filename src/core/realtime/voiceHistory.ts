// src/core/realtime/voiceHistory.ts
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'

import type { GeminiLiveHistoryTurn } from './geminiLiveProtocol'

const userMessageText = (message: ChatUserMessage): string => {
  const { promptContent } = message
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

const assistantMessageText = (message: ChatAssistantMessage): string =>
  message.content

/**
 * Projects the persisted conversation into the turns a fresh Live session is
 * seeded with. Only user/assistant text participates: tool, subagent and
 * terminal-result timeline entries are not conversational context here.
 * Consecutive same-role messages are merged so the replayed sequence alternates.
 */
export const buildVoiceHistoryTurns = (
  messages: readonly ChatMessage[],
): GeminiLiveHistoryTurn[] => {
  const turns: GeminiLiveHistoryTurn[] = []
  const push = (role: GeminiLiveHistoryTurn['role'], raw: string): void => {
    const text = raw.trim()
    if (!text) return
    const last = turns.at(-1)
    if (last && last.role === role) {
      last.text = `${last.text}\n\n${text}`
      return
    }
    turns.push({ role, text })
  }
  for (const message of messages) {
    if (message.role === 'user') push('user', userMessageText(message))
    else if (message.role === 'assistant')
      push('model', assistantMessageText(message))
  }
  return turns
}

/** Drops empty turns; the setup flag and the replayed frame must agree on this. */
export const normalizeVoiceHistoryTurns = (
  turns: readonly GeminiLiveHistoryTurn[],
): GeminiLiveHistoryTurn[] =>
  turns
    .map((turn) => ({ role: turn.role, text: turn.text.trim() }))
    .filter((turn) => turn.text.length > 0)
