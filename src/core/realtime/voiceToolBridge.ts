// src/core/realtime/voiceToolBridge.ts
import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import type { ChatToolMessage } from '../../types/chat'
import type { RequestTool } from '../../types/llm/request'
import type { LLMProviderApiType } from '../../types/provider.types'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { resolveAllowedSkillPaths } from '../agent/agent-api'
import {
  resolveBlockedCommandPrefixes,
  resolveWorkspaceScopeForRuntimeInput,
} from '../agent/chat-runtime-inputs'
import type { ChatModeRuntime } from '../agent/chat-runtime-profiles'
import { AgentToolGateway } from '../agent/tool-gateway'
import {
  buildRequestTools,
  isInvokeToolName,
  isLoadToolSchemasToolName,
  selectAllowedTools,
} from '../agent/tool-selection'
import { GeminiProvider } from '../llm/gemini'
import { fromModelToolName } from '../mcp/localFileTools'
import type { McpManager } from '../mcp/mcpManager'
import { getToolNamesForCapability } from '../tools/registry'

import type {
  GeminiLiveFunctionCall,
  GeminiLiveFunctionDeclaration,
  GeminiLiveFunctionResponse,
} from './geminiLiveProtocol'

export type VoiceToolBridge = {
  declarations: GeminiLiveFunctionDeclaration[]
  handleFunctionCalls(
    calls: GeminiLiveFunctionCall[],
    signal?: AbortSignal,
  ): Promise<GeminiLiveFunctionResponse[]>
}

export type BuildVoiceToolBridgeOptions = {
  mcpManager: McpManager
  conversationId: string
  /** The current mode's runtime, resolved by the caller (`resolveChatModeRuntime`). */
  chatModeRuntime: ChatModeRuntime
  settings: YoloSettings
  /** Needed for the skill-path boundary; the assistant owns the allowed set. */
  app: App
  assistant: Assistant | null
  apiType?: LLMProviderApiType | null
}

const INERT_BRIDGE: VoiceToolBridge = {
  declarations: [],
  handleFunctionCalls: async () => [],
}

const toToolResponsePayload = (
  response: ToolCallResponse,
): Record<string, unknown> => {
  switch (response.status) {
    case ToolCallResponseStatus.Success:
      return { result: response.data.text }
    case ToolCallResponseStatus.Error:
      return { error: response.error }
    case ToolCallResponseStatus.Rejected:
      return { error: response.reason ?? 'Tool call rejected.' }
    case ToolCallResponseStatus.Aborted:
      return { error: 'Tool call was aborted.' }
    default:
      return { error: 'Tool call did not complete.' }
  }
}

/**
 * The request's tool shape (`buildRequestTools`: model-facing name + prepared
 * schema) restated as a Live function declaration, whose `parameters` slot
 * additionally has to survive Gemini's schema sanitizer.
 */
const toDeclaration = (tool: RequestTool): GeminiLiveFunctionDeclaration => ({
  name: tool.function.name,
  description: tool.function.description,
  parameters: GeminiProvider.sanitizeSchemaForGemini(
    tool.function.parameters as Record<string, unknown>,
  ) as Record<string, unknown>,
})

export async function buildVoiceToolBridge(
  options: BuildVoiceToolBridgeOptions,
): Promise<VoiceToolBridge> {
  const { mcpManager, chatModeRuntime, settings, apiType } = options
  if (
    settings.voice.toolsEnabled === false ||
    !chatModeRuntime.loopConfig.enableTools
  ) {
    return INERT_BRIDGE
  }

  const availableTools = await mcpManager.listAvailableTools({
    includeBuiltinTools: chatModeRuntime.loopConfig.includeBuiltinTools,
    chatModelModalities: ['text'],
    capabilityOverrides: chatModeRuntime.capabilityOverrides,
  })

  // These built-ins operate on the chat transcript or on a UI voice does not
  // have; `handleFunctionCalls` passes `conversationMessages: []`.
  const voiceExcludedToolNames = new Set(
    ['context_pruning', 'context_compaction', 'user_questions'].flatMap((id) =>
      getToolNamesForCapability(id),
    ),
  )

  const { filteredTools } = await selectAllowedTools({
    availableTools,
    allowedToolNames: chatModeRuntime.allowedToolNames,
    toolPreferences: chatModeRuntime.toolPreferences,
    toolServerPreferences: chatModeRuntime.toolServerPreferences,
    model: { builtinToolProvider: undefined, builtinTools: undefined },
    apiType,
    jsSandboxSettings: mcpManager.getJsSandboxSettings(),
    settings,
  })

  const declaredTools = filteredTools.filter(
    (tool) =>
      !isInvokeToolName(tool.name) &&
      !isLoadToolSchemasToolName(tool.name) &&
      !voiceExcludedToolNames.has(tool.name),
  )
  const declarations = (buildRequestTools(declaredTools) ?? []).map(
    toDeclaration,
  )

  // The same boundary the text agent runs under in this mode: the assistant's
  // workspace scope (skipped in a module mode, which takes no part of the
  // assistant), the skill paths it may read, and the terminal blocklist.
  const isModuleMode = chatModeRuntime.moduleChatModeId !== undefined
  const allowedSkillPaths = isModuleMode
    ? []
    : await resolveAllowedSkillPaths({
        app: options.app,
        settings,
        assistant: options.assistant,
      })

  const gateway = new AgentToolGateway(mcpManager, {
    toolsEnabled: true,
    allowedToolNames: chatModeRuntime.allowedToolNames,
    toolPreferences: chatModeRuntime.toolPreferences,
    builtinCapabilityPreferences: chatModeRuntime.builtinCapabilityPreferences,
    toolServerPreferences: chatModeRuntime.toolServerPreferences,
    apiType,
    bypassToolApproval: chatModeRuntime.bypassToolApproval,
    bashReadOnly: chatModeRuntime.bashReadOnly,
    moduleToolApprovalPolicies: chatModeRuntime.moduleToolApprovalPolicies,
    capabilityOverrides: chatModeRuntime.capabilityOverrides,
    vaultPathBoundary: chatModeRuntime.vaultPathBoundary,
    toolApprovalConversationId: options.conversationId,
    workspaceScope: isModuleMode
      ? undefined
      : resolveWorkspaceScopeForRuntimeInput(options.assistant),
    allowedSkillPaths,
    blockedCommandPrefixes: resolveBlockedCommandPrefixes(settings),
    // Every schema went out in the setup frame, so no call is behind
    // `load_tool_schemas`; the gateway must not classify one as deferred.
    advertisesAllToolSchemas: true,
  })

  let callCounter = 0

  const handleFunctionCalls = async (
    calls: GeminiLiveFunctionCall[],
    signal?: AbortSignal,
  ): Promise<GeminiLiveFunctionResponse[]> => {
    if (calls.length === 0) return []

    const toolCallRequests: ToolCallRequest[] = calls.map((call) => ({
      id: call.id ?? `voice-tool-${++callCounter}`,
      name: fromModelToolName(call.name),
      arguments: createCompleteToolCallArguments({ value: call.args ?? {} }),
    }))

    const created = gateway.createToolMessage({
      toolCallRequests,
      conversationId: options.conversationId,
    })

    // Voice has no approval affordance: convert anything that would pause for
    // the user into a rejected response the model can explain out loud.
    const normalized: ChatToolMessage = {
      ...created,
      toolCalls: created.toolCalls.map(({ request, response }) =>
        response.status === ToolCallResponseStatus.PendingApproval ||
        response.status === ToolCallResponseStatus.AwaitingUserInput
          ? {
              request,
              response: {
                status: ToolCallResponseStatus.Rejected,
                reason:
                  'Voice mode cannot ask for tool approval. Enable YOLO for this chat mode or use text chat to run this tool.',
              },
            }
          : { request, response },
      ),
    }

    const executed = await gateway.executeAutoToolCalls({
      toolMessage: normalized,
      conversationId: options.conversationId,
      conversationMessages: [],
      signal,
    })

    // Queue rather than a plain map: two calls can legitimately carry the same
    // explicit server id, and a map would collapse their distinct results into
    // one payload. Consume one payload per request, in call order.
    const payloadsById = new Map<string, Record<string, unknown>[]>()
    for (const { request, response } of executed.toolCalls) {
      const queue = payloadsById.get(request.id) ?? []
      queue.push(toToolResponsePayload(response))
      payloadsById.set(request.id, queue)
    }

    // Always answer every function call exactly once, even if the gateway
    // merged same-file edit calls into a single execution entry.
    return calls.map((call, index) => {
      const request = toolCallRequests[index]
      const payload = payloadsById.get(request.id)?.shift()
      return {
        id: call.id,
        name: call.name,
        response: payload ?? { error: 'Tool call did not complete.' },
      }
    })
  }

  return { declarations, handleFunctionCalls }
}
