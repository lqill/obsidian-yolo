import type { VoiceLiveTurn, VoiceTurn } from '../../core/realtime'
import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'

import { plainTextToEditorState } from './chat-input/utils/plain-text-to-editor-state'

/**
 * Ids for one voice turn. The user and assistant messages share a base so a
 * turn's pair is recognizable, and both ids live for the whole turn: the live
 * messages carry them while the turn streams, and the finalized ones reuse them
 * so the bubble that streamed becomes the persisted message.
 */
export const createVoiceLiveTurn = (conversationId: string): VoiceLiveTurn => {
  const base = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    conversationId,
    userMessageId: `${base}-user`,
    assistantMessageId: `${base}-assistant`,
  }
}

/**
 * The turn's messages as they enter the conversation, before any text exists:
 * the store's partial transcripts stream into these bubbles, and the streaming
 * generation state is what makes the timeline treat the assistant one as live.
 */
export const buildLiveTurnMessages = ({
  liveTurn,
  model,
  liveModelId,
}: {
  liveTurn: VoiceLiveTurn
  model: ChatModel | undefined
  liveModelId: string
}): readonly [ChatUserMessage, ChatAssistantMessage] => [
  {
    role: 'user',
    id: liveTurn.userMessageId,
    content: null,
    promptContent: '',
    mentionables: [],
    selectedModelIds: [liveModelId],
  },
  {
    role: 'assistant',
    id: liveTurn.assistantMessageId,
    content: '',
    metadata: { generationState: 'streaming', model },
  },
]

/** The committed turn, under the same ids the live messages used. */
export const buildFinalTurnMessages = ({
  liveTurn,
  turn,
  model,
  liveModelId,
  stampTimeContext,
}: {
  liveTurn: VoiceLiveTurn
  turn: VoiceTurn
  model: ChatModel | undefined
  liveModelId: string
  stampTimeContext?: (message: ChatUserMessage) => ChatUserMessage
}): readonly [ChatUserMessage, ChatAssistantMessage] => {
  const baseUserMessage: ChatUserMessage = {
    role: 'user',
    id: liveTurn.userMessageId,
    content: plainTextToEditorState(turn.userText),
    promptContent: turn.userText,
    mentionables: [],
    selectedModelIds: [liveModelId],
  }
  return [
    stampTimeContext ? stampTimeContext(baseUserMessage) : baseUserMessage,
    {
      role: 'assistant',
      id: liveTurn.assistantMessageId,
      content: turn.assistantText,
      metadata: { generationState: 'completed', model },
    },
  ]
}
