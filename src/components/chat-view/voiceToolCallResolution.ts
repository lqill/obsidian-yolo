import type { AgentSessionService } from '../../core/agent/service'
import type { ChatMessage } from '../../types/chat'
import type { ToolCallResponse } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

/**
 * A response the caller can stop waiting on. `Running` still means the gateway
 * or the approval recovery path is executing the tool; `PendingApproval` and
 * `AwaitingUserInput` still mean the user has not acted yet.
 */
const isResolvedResponse = (response: ToolCallResponse): boolean =>
  response.status !== ToolCallResponseStatus.Running &&
  response.status !== ToolCallResponseStatus.PendingApproval &&
  response.status !== ToolCallResponseStatus.AwaitingUserInput

/**
 * Resolves when every given voice tool call has left the conversation's pending
 * states — the approval card was answered (or the call executed outright), no
 * matter which surface wrote the result.
 *
 * Reads from the agent conversation rather than holding its own state, because
 * the write that resolves a call comes from the chat surface's approval
 * recovery path, which only knows the conversation. An abort (the voice session
 * stopping) resolves the remainder as aborted so the Live turn is never left
 * blocked on a card the user can no longer act on.
 */
export const awaitVoiceToolCallResolution = ({
  agentService,
  conversationId,
  toolCallIds,
  signal,
}: {
  agentService: Pick<AgentSessionService, 'subscribe'>
  conversationId: string
  toolCallIds: readonly string[]
  signal?: AbortSignal
}): Promise<Map<string, ToolCallResponse>> =>
  new Promise((resolve) => {
    const pending = new Set(toolCallIds)
    const resolved = new Map<string, ToolCallResponse>()
    if (pending.size === 0) {
      resolve(resolved)
      return
    }

    let unsubscribe: (() => void) | null = null
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      signal?.removeEventListener('abort', onAbort)
      resolve(resolved)
    }

    const onAbort = (): void => {
      for (const id of pending) {
        resolved.set(id, { status: ToolCallResponseStatus.Aborted })
      }
      pending.clear()
      finish()
    }

    const scan = (messages: readonly ChatMessage[]): void => {
      for (const message of messages) {
        if (message.role !== 'tool') continue
        for (const toolCall of message.toolCalls) {
          if (!pending.has(toolCall.request.id)) continue
          if (!isResolvedResponse(toolCall.response)) continue
          resolved.set(toolCall.request.id, toolCall.response)
          pending.delete(toolCall.request.id)
        }
      }
      if (pending.size === 0) finish()
    }

    // `subscribe` replays the current state before returning, so a call that
    // resolved before this ran is still caught; the release then has to be
    // applied by hand because `finish` saw a null unsubscribe.
    const release = agentService.subscribe(conversationId, (state) =>
      scan(state.messages),
    )
    unsubscribe = release
    if (settled) {
      release()
      return
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
  })
