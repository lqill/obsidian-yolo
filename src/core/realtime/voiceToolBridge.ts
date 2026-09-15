// src/core/realtime/voiceToolBridge.ts
import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantToolServerPreference,
} from '../../types/assistant.types'
import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { LLMProviderApiType } from '../../types/provider.types'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { ChatMode } from '../agent/chat-mode'
import {
  type ChatModeRuntime,
  resolveChatModeRuntime,
} from '../agent/chat-runtime-profiles'
import { AgentToolGateway } from '../agent/tool-gateway'
import { getEnabledAssistantToolNames } from '../agent/tool-preferences'
import {
  isInvokeToolName,
  isLoadToolSchemasToolName,
  selectAllowedTools,
} from '../agent/tool-selection'
import { GeminiProvider } from '../llm/gemini'
import {
  fromModelToolName,
  getLocalFileToolServerName,
  toModelToolName,
} from '../mcp/localFileTools'
import type { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'
import type { RegisteredModuleChatModeV1 } from '../modules/moduleChatModeRegistry'
import {
  type RegisteredModuleToolSetV1,
  toModuleToolSetEnablement,
} from '../modules/moduleToolSetRegistry'
import { getToolNamesForCapability } from '../tools/registry'

import type {
  GeminiLiveFunctionCall,
  GeminiLiveFunctionDeclaration,
  GeminiLiveFunctionResponse,
} from './geminiLiveProtocol'

type AgentToolGatewayOptions = NonNullable<
  ConstructorParameters<typeof AgentToolGateway>[1]
>

export type VoiceToolGatewayLike = {
  createToolMessage(input: {
    toolCallRequests: ToolCallRequest[]
    conversationId: string
  }): ChatToolMessage
  executeAutoToolCalls(input: {
    toolMessage: ChatToolMessage
    conversationId: string
    conversationMessages?: ChatMessage[]
    signal?: AbortSignal
  }): Promise<ChatToolMessage>
}

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
  chatModeRuntime: ChatModeRuntime
  settings: YoloSettings
  apiType?: LLMProviderApiType | null
  createGateway?: (
    mcpManager: McpManager,
    options: AgentToolGatewayOptions,
  ) => VoiceToolGatewayLike
}

export type BuildVoiceToolBridgeFromChatOptions = {
  mcpManager: McpManager
  conversationId: string
  settings: YoloSettings
  chatMode: ChatMode
  yoloEnabled: boolean
  app: App
  selectedAssistant: Assistant | null
  moduleToolSets: readonly RegisteredModuleToolSetV1[]
  moduleChatMode?: RegisteredModuleChatModeV1
}

const INERT_BRIDGE: VoiceToolBridge = {
  declarations: [],
  handleFunctionCalls: async () => [],
}

const defaultCreateGateway = (
  mcpManager: McpManager,
  options: AgentToolGatewayOptions,
): VoiceToolGatewayLike => new AgentToolGateway(mcpManager, options)

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

const toDeclaration = (tool: {
  name: string
  description?: string
  inputSchema?: unknown
}): GeminiLiveFunctionDeclaration => {
  const schema = (tool.inputSchema ?? { type: 'object' }) as Record<
    string,
    unknown
  >
  const withProperties = {
    ...schema,
    properties:
      (schema.properties as Record<string, unknown> | undefined) ?? {},
  }
  return {
    name: toModelToolName(tool.name),
    description: tool.description,
    parameters: GeminiProvider.sanitizeSchemaForGemini(
      withProperties,
    ) as Record<string, unknown>,
  }
}

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

  // Voice advertises every enabled tool directly, so promote each server from
  // the text agent's default `on_demand` tier to `always`. The gateway reads the
  // same map, otherwise `isOnDemandToolName` would still classify these as
  // on-demand and reject the direct call as "schema not loaded". Configured
  // (possibly offline) servers matter too: an offline server still contributes a
  // deferred catalog entry, so promote from `settings.mcp.servers` as well.
  const voiceToolServerPreferences: Record<
    string,
    AssistantToolServerPreference
  > = { ...(chatModeRuntime.toolServerPreferences ?? {}) }
  const promoteServer = (rawName: string): void => {
    try {
      const { serverName } = parseToolName(rawName)
      if (serverName === getLocalFileToolServerName()) return
      voiceToolServerPreferences[serverName] = {
        ...voiceToolServerPreferences[serverName],
        disclosureMode: 'always',
      }
    } catch {
      // Names without a server prefix are never on-demand.
    }
  }
  for (const tool of availableTools) promoteServer(tool.name)
  for (const server of settings.mcp.servers ?? []) {
    const serverId = server.id
    if (!serverId || serverId === getLocalFileToolServerName()) continue
    voiceToolServerPreferences[serverId] = {
      ...voiceToolServerPreferences[serverId],
      disclosureMode: 'always',
    }
  }

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
    toolServerPreferences: voiceToolServerPreferences,
    model: { builtinToolProvider: undefined, builtinTools: undefined },
    apiType,
    jsSandboxSettings: mcpManager.getJsSandboxSettings(),
    settings,
  })

  const declarations = filteredTools
    .filter(
      (tool) =>
        !isInvokeToolName(tool.name) &&
        !isLoadToolSchemasToolName(tool.name) &&
        !voiceExcludedToolNames.has(tool.name),
    )
    .map(toDeclaration)

  const createGateway = options.createGateway ?? defaultCreateGateway
  const gateway = createGateway(mcpManager, {
    toolsEnabled: true,
    allowedToolNames: chatModeRuntime.allowedToolNames,
    toolPreferences: chatModeRuntime.toolPreferences,
    builtinCapabilityPreferences: chatModeRuntime.builtinCapabilityPreferences,
    toolServerPreferences: voiceToolServerPreferences,
    apiType,
    bypassToolApproval: chatModeRuntime.bypassToolApproval,
    bashReadOnly: chatModeRuntime.bashReadOnly,
    moduleToolApprovalPolicies: chatModeRuntime.moduleToolApprovalPolicies,
    capabilityOverrides: chatModeRuntime.capabilityOverrides,
    vaultPathBoundary: chatModeRuntime.vaultPathBoundary,
    toolApprovalConversationId: options.conversationId,
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
    const payloadsById = new Map<
      string,
      Array<ReturnType<typeof toToolResponsePayload>>
    >()
    for (const { request, response } of executed.toolCalls) {
      const payload = toToolResponsePayload(response)
      const queued = payloadsById.get(request.id)
      if (queued) queued.push(payload)
      else payloadsById.set(request.id, [payload])
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

export async function buildVoiceToolBridgeFromChat(
  options: BuildVoiceToolBridgeFromChatOptions,
): Promise<VoiceToolBridge> {
  const chatModeRuntime = resolveChatModeRuntime({
    mode: options.chatMode,
    yoloEnabled: options.yoloEnabled,
    app: options.app,
    assistant: options.selectedAssistant,
    assistantEnabledToolNames: getEnabledAssistantToolNames(
      options.selectedAssistant,
      toModuleToolSetEnablement(options.moduleToolSets),
    ),
    moduleChatMode: options.moduleChatMode,
  })
  return buildVoiceToolBridge({
    mcpManager: options.mcpManager,
    conversationId: options.conversationId,
    chatModeRuntime,
    settings: options.settings,
    apiType: 'gemini',
  })
}
