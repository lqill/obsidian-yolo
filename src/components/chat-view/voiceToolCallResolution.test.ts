import type { AgentConversationState } from '../../core/agent/service'
import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { ToolCallResponse } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { awaitVoiceToolCallResolution } from './voiceToolCallResolution'

const makeAgentService = (initialMessages: ChatMessage[] = []) => {
  const subscribers = new Set<(state: AgentConversationState) => void>()
  let messages: ChatMessage[] = initialMessages
  const replaceConversationMessages = jest.fn(
    (_conversationId: string, next: ChatMessage[]) => {
      messages = next
    },
  )
  return {
    subscribe: jest.fn(
      (
        _conversationId: string,
        callback: (state: AgentConversationState) => void,
      ) => {
        subscribers.add(callback)
        callback({ messages } as AgentConversationState)
        return () => subscribers.delete(callback)
      },
    ),
    getState: jest.fn(() => ({ messages }) as AgentConversationState),
    replaceConversationMessages,
    emit(next: ChatMessage[]) {
      messages = next
      for (const callback of [...subscribers]) {
        callback({ messages } as AgentConversationState)
      }
    },
    countSubscribers() {
      return subscribers.size
    },
  }
}

const toolMessage = (
  id: string,
  toolCallId: string,
  response: ToolCallResponse,
  metadata?: ChatToolMessage['metadata'],
): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: [
    {
      request: {
        id: toolCallId,
        name: 'fs_write',
        arguments: { kind: 'complete', value: {}, rawText: undefined },
      },
      response,
    },
  ],
  ...(metadata ? { metadata } : {}),
})

const successResponse: ToolCallResponse = {
  status: ToolCallResponseStatus.Success,
  data: { type: 'text', text: 'done' },
}

describe('awaitVoiceToolCallResolution', () => {
  it('resolves once every call leaves the pending states', async () => {
    const agentService = makeAgentService()
    const promise = awaitVoiceToolCallResolution({
      agentService,
      conversationId: 'c1',
      toolCallIds: ['call1'],
    })

    agentService.emit([
      toolMessage('t1', 'call1', {
        status: ToolCallResponseStatus.PendingApproval,
      }),
    ])
    agentService.emit([
      toolMessage('t1', 'call1', {
        status: ToolCallResponseStatus.Running,
      }),
    ])
    agentService.emit([toolMessage('t1', 'call1', successResponse)])

    await expect(promise).resolves.toEqual(
      new Map([['call1', successResponse]]),
    )
    // The subscription is released once the batch is settled.
    expect(agentService.countSubscribers()).toBe(0)
  })

  it('catches a call that was already resolved before it subscribed', async () => {
    const agentService = makeAgentService([
      toolMessage('t1', 'call1', successResponse),
    ])
    const promise = awaitVoiceToolCallResolution({
      agentService,
      conversationId: 'c1',
      toolCallIds: ['call1'],
    })

    await expect(promise).resolves.toEqual(
      new Map([['call1', successResponse]]),
    )
    expect(agentService.countSubscribers()).toBe(0)
  })

  it('reports still-pending calls as aborted when the session aborts', async () => {
    const agentService = makeAgentService()
    const controller = new AbortController()
    const promise = awaitVoiceToolCallResolution({
      agentService,
      conversationId: 'c1',
      toolCallIds: ['call1', 'call2'],
      signal: controller.signal,
    })

    agentService.emit([
      toolMessage('t1', 'call1', {
        status: ToolCallResponseStatus.PendingApproval,
      }),
      toolMessage('t2', 'call2', {
        status: ToolCallResponseStatus.PendingApproval,
      }),
    ])
    controller.abort()

    const resolved = await promise
    expect(resolved.get('call1')).toEqual({
      status: ToolCallResponseStatus.Aborted,
    })
    expect(resolved.get('call2')).toEqual({
      status: ToolCallResponseStatus.Aborted,
    })
    expect(agentService.countSubscribers()).toBe(0)
  })

  it('resolves immediately with an empty map when there is nothing to wait for', async () => {
    const agentService = makeAgentService()
    await expect(
      awaitVoiceToolCallResolution({
        agentService,
        conversationId: 'c1',
        toolCallIds: [],
      }),
    ).resolves.toEqual(new Map())
    expect(agentService.subscribe).not.toHaveBeenCalled()
  })
})
