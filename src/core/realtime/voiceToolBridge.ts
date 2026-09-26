// src/core/realtime/voiceToolBridge.ts
import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import type { ChatToolMessage } from '../../types/chat'
import type { RequestTool } from '../../types/llm/request'
import type { LLMProviderApiType } from '../../types/provider.types'
import type {
  ToolCallRequest,
  ToolCallResponse,
} from '../../types/tool-call.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { resolveAllowedSkillPaths } from '../agent/agent-api'
import {
  resolveBlockedCommandPrefixes,
  resolveWorkspaceScopeForRuntimeInput,
} from '../agent/chat-runtime-inputs'
import type { ChatModeRuntime } from '../agent/chat-runtime-profiles'
import { buildRuntimeModePrompt } from '../agent/runtime-mode-prompt'
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
  /**
   * The voice session's system instruction: the chat model's own assembled
   * system prompt (`RequestContextBuilder.generateSystemPrompt`) plus
   * `settings.voice.systemPrompt` as a voice-only addendum. It lives here
   * because the prompt and the tool grant share one `ChatModeRuntime` and one
   * tool selection, so resolving them apart would mean resolving twice.
   */
  systemPrompt: string
  declarations: GeminiLiveFunctionDeclaration[]
  handleFunctionCalls(
    calls: GeminiLiveFunctionCall[],
    signal?: AbortSignal,
  ): Promise<GeminiLiveFunctionResponse[]>
}

export type BuildVoiceToolBridgeOptions = {
  mcpManager: McpManager
  /** Builds the shared prompt half — see `VoiceToolBridge.systemPrompt`. */
  requestContextBuilder: RequestContextBuilder
  conversationId: string
  /** The current mode's runtime, resolved by the caller (`resolveChatModeRuntime`). */
  chatModeRuntime: ChatModeRuntime
  settings: YoloSettings
  /** Needed for the skill-path boundary; the assistant owns the allowed set. */
  app: App
  assistant: Assistant | null
  apiType?: LLMProviderApiType | null
  /**
   * Where a voice tool call becomes visible to the user. A call the gateway
   * parks in `PendingApproval` is resolved by the chat surface's normal approval
   * card, so the bridge has to publish the message and wait for that resolution
   * instead of rejecting it the way a surface with no approval affordance would.
   */
  conversationPort: VoiceToolConversationPort
}

/**
 * The bridge's one seam into the chat surface. Deliberately narrow: the bridge
 * owns a tool call's lifecycle, the surface owns where the call is shown and
 * how the user resolves it.
 */
export type VoiceToolConversationPort = {
  /**
   * Inserts or replaces the tool message in the voice session's conversation, so
   * the chat timeline renders it exactly like a text agent's tool call.
   */
  publish(message: ChatToolMessage): void
  /**
   * Resolves once every id has a terminal response — the user approved or
   * rejected it, or the session aborted and the call is reported as aborted.
   */
  awaitResolution(
    toolCallIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ToolCallResponse>>
}

/**
 * The chat model's own assembled system prompt, with `hasTools` reflecting what
 * this voice session actually advertises — the base-behaviour section must not
 * describe tools this session did not send. The voice addendum is appended, not
 * swapped in, so voice keeps its own instructions *on top of* the shared ones.
 */
const buildSystemPrompt = async (
  options: BuildVoiceToolBridgeOptions,
  hasTools: boolean,
): Promise<string> => {
  const { requestContextBuilder, chatModeRuntime, settings, conversationId } =
    options
  const shared = await requestContextBuilder.generateSystemPrompt({
    conversationId,
    hasTools,
    // Every advertised tool's schema rides the setup frame (the gateway is
    // built with `advertisesAllToolSchemas: true`), so there is no two-step
    // disclosure for the model to be told about.
    hasOnDemandTools: false,
    runtimeModePrompt: buildRuntimeModePrompt(chatModeRuntime.runtimeMode),
    modeEnvironmentPrompt: chatModeRuntime.modeEnvironmentPrompt,
    modePersonaPrompt: chatModeRuntime.modePersonaPrompt,
    modePersonaModuleId: chatModeRuntime.modePersonaModuleId,
    moduleChatModeId: chatModeRuntime.moduleChatModeId,
    contextPolicy: chatModeRuntime.contextPolicy,
    // Reuse the conversation's frozen chat prompt when the text path already
    // built one; never freeze one from the voice path, which is not the request
    // that defines it (see `SystemPromptSnapshotMode`).
    systemPromptSnapshotMode: 'reuse',
  })
  const addendum = (settings.voice.systemPrompt ?? '').trim()
  return addendum ? `${shared}\n\n${addendum}` : shared
}

const INERT_TOOL_HANDLER = async (): Promise<GeminiLiveFunctionResponse[]> => []

const isTerminalToolResponse = (response: ToolCallResponse): boolean =>
  response.status !== ToolCallResponseStatus.Running &&
  response.status !== ToolCallResponseStatus.PendingApproval &&
  response.status !== ToolCallResponseStatus.AwaitingUserInput

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
    // Tools are off, but the prompt still is not: the session keeps the shared
    // profile and instructions, just with no function declarations.
    return {
      systemPrompt: await buildSystemPrompt(options, false),
      declarations: [],
      handleFunctionCalls: INERT_TOOL_HANDLER,
    }
  }

  const availableTools = await mcpManager.listAvailableTools({
    includeBuiltinTools: chatModeRuntime.loopConfig.includeBuiltinTools,
    chatModelModalities: ['text'],
    capabilityOverrides: chatModeRuntime.capabilityOverrides,
  })

  // These built-ins operate on the chat transcript or on a UI voice does not
  // have; `handleFunctionCalls` passes `conversationMessages: []`.
  const voiceExcludedToolNames = new Set(
    ['context_pruning', 'context_compaction'].flatMap((id) =>
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
    // Show the call (and any approval card it needs) before touching the tool,
    // so the user sees the same pending card the text agent produces.
    options.conversationPort.publish(created)

    const executed = await gateway.executeAutoToolCalls({
      toolMessage: created,
      conversationId: options.conversationId,
      conversationMessages: [],
      signal,
    })

    // `executeAutoToolCalls` runs everything the gateway already cleared and
    // leaves a call that needs the user in `PendingApproval`. That call is the
    // chat surface's to resolve (the user taps approve/reject on the card the
    // publish above put on screen), so hold the Live turn open until it lands.
    const awaitingResolution = executed.toolCalls.filter(
      ({ response }) =>
        response.status === ToolCallResponseStatus.PendingApproval ||
        response.status === ToolCallResponseStatus.AwaitingUserInput,
    )
    let finalToolMessage = executed
    if (awaitingResolution.length > 0) {
      const resolved = await options.conversationPort.awaitResolution(
        awaitingResolution.map((toolCall) => toolCall.request.id),
        signal,
      )
      finalToolMessage = {
        ...executed,
        toolCalls: executed.toolCalls.map((toolCall) => {
          const response = resolved.get(toolCall.request.id)
          return response ? { ...toolCall, response } : toolCall
        }),
      }
    }
    // A stopped session must not leave a card (or a spinner) waiting on a model
    // that is gone, so anything the abort left unresolved becomes aborted.
    if (signal?.aborted) {
      finalToolMessage = {
        ...finalToolMessage,
        toolCalls: finalToolMessage.toolCalls.map((toolCall) =>
          isTerminalToolResponse(toolCall.response)
            ? toolCall
            : {
                ...toolCall,
                response: { status: ToolCallResponseStatus.Aborted },
              },
        ),
      }
    }
    // Republish the settled message. On the approval path the surface already
    // wrote the same content; on the abort path this is what clears a card that
    // would otherwise be left waiting forever.
    options.conversationPort.publish(finalToolMessage)

    // Queue rather than a plain map: two calls can legitimately carry the same
    // explicit server id, and a map would collapse their distinct results into
    // one payload. Consume one payload per request, in call order.
    const payloadsById = new Map<string, Record<string, unknown>[]>()
    for (const { request, response } of finalToolMessage.toolCalls) {
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

  return {
    systemPrompt: await buildSystemPrompt(options, declarations.length > 0),
    declarations,
    handleFunctionCalls,
  }
}
