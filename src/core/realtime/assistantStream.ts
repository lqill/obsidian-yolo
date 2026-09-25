// src/core/realtime/assistantStream.ts
/**
 * Where the assistant's spoken text goes while a turn runs. The chat surface
 * implements this over the agent's own render stream, so a voice turn drives
 * the same bubble the text agent does — one streaming channel, not two.
 *
 * `begin`/`end` bracket the turn: while a message id is registered, the
 * conversation's structural fold-back leaves its stream entry alone and the
 * terminal pass keeps it live.
 */
export type RealtimeVoiceAssistantStream = {
  begin: (conversationId: string, messageId: string) => void
  end: (conversationId: string, messageId: string) => void
  publish: (input: {
    conversationId: string
    messageId: string
    content: string
  }) => void
}
