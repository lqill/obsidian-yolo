// src/core/realtime/voiceToolBridge.test.ts
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { AgentToolGateway } from '../agent/tool-gateway'
import {
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { INVOKE_TOOL_NAME } from '../tools/internal/invoke_tool/definition'
import { getToolNamesForCapability } from '../tools/registry'

import type { VoiceToolConversationPort } from './voiceToolBridge'
import { buildVoiceToolBridge } from './voiceToolBridge'

// The bridge builds a real gateway; these tests observe the options it was
// built with, and drive what it returns.
jest.mock('../agent/tool-gateway', () => ({ AgentToolGateway: jest.fn() }))
// The skill-path lookup reads the vault through `app`, which these tests do not
// have; what matters here is that its result reaches the gateway.
jest.mock('../agent/agent-api', () => ({
  ...jest.requireActual('../agent/agent-api'),
  resolveAllowedSkillPaths: jest.fn(async () => ['Skills/pkg/SKILL.md']),
}))

const localServer = getLocalFileToolServerName()
const invokeFqn = `${localServer}__${INVOKE_TOOL_NAME}`
const loadFqn = `${localServer}__${LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME}`

type FakeGateway = {
  createToolMessage: jest.Mock
  executeAutoToolCalls: jest.Mock
}

const gatewayConstructor = AgentToolGateway as unknown as jest.Mock

const installGateway = (gateway: FakeGateway): void => {
  gatewayConstructor.mockImplementation(() => gateway)
}

/** The options the bridge handed the gateway it constructed. */
const gatewayOptions = (): Record<string, unknown> =>
  gatewayConstructor.mock.calls.at(-1)?.[1]

const fsReadTool = {
  name: `${localServer}__fs_read`,
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    additionalProperties: false,
  },
}

const mcpTool = {
  name: 'srv__search',
  description: 'Search a server',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}

const makeSettings = (toolsEnabled = true) =>
  ({
    voice: { toolsEnabled },
    knowledgeBases: [],
    mcp: { servers: [], discoveredCatalogs: {}, builtinCapabilityOptions: {} },
    chatModels: [],
    providers: [],
    jsSandbox: {},
  }) as any

const makeRuntime = (overrides: Record<string, unknown> = {}) =>
  ({
    loopConfig: { enableTools: true, includeBuiltinTools: true },
    allowedToolNames: [fsReadTool.name, mcpTool.name, invokeFqn, loadFqn],
    toolPreferences: undefined,
    builtinCapabilityPreferences: undefined,
    toolServerPreferences: undefined,
    bypassToolApproval: false,
    runtimeMode: 'agent',
    bashReadOnly: false,
    capabilityOverrides: undefined,
    vaultPathBoundary: undefined,
    moduleToolApprovalPolicies: undefined,
    contextPolicy: { useAssistant: true },
    ...overrides,
  }) as any

const makeMcpManager = () =>
  ({
    listAvailableTools: jest.fn(async () => [
      fsReadTool,
      mcpTool,
      {
        name: invokeFqn,
        description: 'invoke',
        inputSchema: { type: 'object' },
      },
      { name: loadFqn, description: 'load', inputSchema: { type: 'object' } },
    ]),
    getJsSandboxSettings: jest.fn(() => ({})),
    getSettingsSnapshot: jest.fn(() => makeSettings()),
  }) as any

const makeGateway = (
  initialResponses: Record<string, any> = {},
): FakeGateway => ({
  createToolMessage: jest.fn(
    ({ toolCallRequests }: { toolCallRequests: ToolCallRequest[] }) => ({
      role: 'tool',
      id: 'tm1',
      toolCalls: toolCallRequests.map((request) => ({
        request,
        response: initialResponses[request.name] ?? {
          status: ToolCallResponseStatus.Running,
        },
      })),
    }),
  ),
  executeAutoToolCalls: jest.fn(async ({ toolMessage }: any) => ({
    ...toolMessage,
    toolCalls: toolMessage.toolCalls.map(({ request, response }: any) => ({
      request,
      response:
        response.status === ToolCallResponseStatus.Running
          ? {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: `ok:${request.name}` },
            }
          : response,
    })),
  })),
})

/**
 * The chat surface's stand-in: `publish` is observed, and `awaitResolution`
 * hands back whatever the test decided the user did with an approval card.
 */
const makeConversationPort = (
  resolutions: Record<string, ToolCallResponse> = {},
): VoiceToolConversationPort & {
  publish: jest.Mock
  awaitResolution: jest.Mock
} => ({
  publish: jest.fn(),
  awaitResolution: jest.fn(async (toolCallIds: readonly string[]) => {
    const resolved = new Map<string, ToolCallResponse>()
    for (const id of toolCallIds) {
      const response = resolutions[id]
      if (response) resolved.set(id, response)
    }
    return resolved
  }),
})

/**
 * No assistant unless a test needs one: the skill-path lookup then
 * short-circuits and the `app` stub is never touched.
 */
const makeRequestContextBuilder = (sharedPrompt = 'SHARED PROMPT') =>
  ({
    generateSystemPrompt: jest.fn(async () => sharedPrompt),
  }) as any

/**
 * No assistant unless a test needs one: the skill-path lookup then
 * short-circuits and the `app` stub is never touched.
 */
const buildBridge = (
  overrides: {
    mcpManager?: unknown
    chatModeRuntime?: unknown
    settings?: unknown
    assistant?: unknown
    requestContextBuilder?: unknown
    conversationPort?: VoiceToolConversationPort
  } = {},
) =>
  buildVoiceToolBridge({
    mcpManager: (overrides.mcpManager ?? makeMcpManager()) as never,
    requestContextBuilder: (overrides.requestContextBuilder ??
      makeRequestContextBuilder()) as never,
    conversationId: 'c1',
    app: {} as never,
    assistant: (overrides.assistant ?? null) as never,
    chatModeRuntime: (overrides.chatModeRuntime ?? makeRuntime()) as never,
    settings: (overrides.settings ?? makeSettings()) as never,
    conversationPort: overrides.conversationPort ?? makeConversationPort(),
  })

describe('buildVoiceToolBridge', () => {
  beforeEach(() => gatewayConstructor.mockReset())

  it('advertises enabled tools under model names, drops protocol wrappers, and sanitizes schemas', async () => {
    installGateway(makeGateway())
    const bridge = await buildBridge()

    const names = bridge.declarations.map((declaration) => declaration.name)
    expect(names).toEqual(['fs_read', 'srv__search'])
    expect(bridge.declarations[0]).toEqual({
      name: 'fs_read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    })
  })

  it('executes calls through the gateway and maps results back to model names', async () => {
    const gateway = makeGateway()
    installGateway(gateway)
    const bridge = await buildBridge()

    const responses = await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_read', args: { path: 'a.md' } },
    ])

    expect(gateway.createToolMessage).toHaveBeenCalledWith({
      toolCallRequests: [
        {
          id: 'call1',
          name: `${localServer}__fs_read`,
          arguments: {
            kind: 'complete',
            value: { path: 'a.md' },
            rawText: undefined,
          },
        },
      ],
      conversationId: 'c1',
    })
    expect(responses).toEqual([
      {
        id: 'call1',
        name: 'fs_read',
        response: { result: `ok:${localServer}__fs_read` },
      },
    ])
  })

  it('publishes a pending call, waits for the surface to resolve it, and reports the result', async () => {
    const gateway = makeGateway({
      [`${localServer}__fs_write`]: {
        status: ToolCallResponseStatus.PendingApproval,
      },
    })
    installGateway(gateway)
    const conversationPort = makeConversationPort({
      call1: {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: 'written' },
      },
    })
    const bridge = await buildBridge({ conversationPort })

    const responses = await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_write', args: { path: 'a.md' } },
    ])

    expect(responses).toEqual([
      {
        id: 'call1',
        name: 'fs_write',
        response: { result: 'written' },
      },
    ])
    expect(conversationPort.awaitResolution).toHaveBeenCalledWith(
      ['call1'],
      undefined,
    )
    // Once with the pending card, once settled.
    expect(conversationPort.publish).toHaveBeenCalledTimes(2)
  })

  it('publishes every auto-executed call so the timeline shows it', async () => {
    installGateway(makeGateway())
    const conversationPort = makeConversationPort()
    const bridge = await buildBridge({ conversationPort })

    await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_read', args: { path: 'a.md' } },
    ])

    expect(conversationPort.awaitResolution).not.toHaveBeenCalled()
    expect(conversationPort.publish).toHaveBeenCalledTimes(2)
  })

  it('reports a call the aborted session left unresolved as aborted', async () => {
    const gateway = makeGateway({
      [`${localServer}__fs_write`]: {
        status: ToolCallResponseStatus.PendingApproval,
      },
    })
    installGateway(gateway)
    const conversationPort = makeConversationPort()
    conversationPort.awaitResolution.mockImplementation(
      async (toolCallIds: readonly string[], signal?: AbortSignal) => {
        const aborted = () =>
          new Map(
            toolCallIds.map((id) => [
              id,
              { status: ToolCallResponseStatus.Aborted },
            ]),
          )
        if (signal?.aborted) return aborted()
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return aborted()
      },
    )
    const bridge = await buildBridge({ conversationPort })
    const controller = new AbortController()

    const responsesPromise = bridge.handleFunctionCalls(
      [{ id: 'call1', name: 'fs_write', args: { path: 'a.md' } }],
      controller.signal,
    )
    controller.abort()

    await expect(responsesPromise).resolves.toEqual([
      {
        id: 'call1',
        name: 'fs_write',
        response: { error: 'Tool call was aborted.' },
      },
    ])
    const finalPublish = conversationPort.publish.mock.calls.at(-1)?.[0]
    expect(finalPublish.toolCalls[0].response.status).toBe(
      ToolCallResponseStatus.Aborted,
    )
  })

  it('returns a response for every incoming call when the gateway merges entries', async () => {
    const gateway = makeGateway()
    gateway.executeAutoToolCalls.mockResolvedValueOnce({
      role: 'tool',
      id: 'tm1',
      toolCalls: [],
    })
    installGateway(gateway)
    const bridge = await buildBridge()

    const responses = await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_read', args: {} },
      { id: 'call2', name: 'fs_read', args: {} },
    ])

    expect(responses).toHaveLength(2)
    expect(responses.every((response) => 'error' in response.response)).toBe(
      true,
    )
  })

  it('answers each call with its own result even when two calls share an id', async () => {
    installGateway(makeGateway())
    const bridge = await buildBridge()

    const responses = await bridge.handleFunctionCalls([
      { id: 'dup', name: 'fs_read', args: {} },
      { id: 'dup', name: 'fs_write', args: {} },
    ])

    expect(responses).toEqual([
      {
        id: 'dup',
        name: 'fs_read',
        response: { result: 'ok:yolo_local__fs_read' },
      },
      {
        id: 'dup',
        name: 'fs_write',
        response: { result: 'ok:yolo_local__fs_write' },
      },
    ])
  })

  it('tells the gateway every schema went out, and passes preferences through unchanged', async () => {
    installGateway(makeGateway())
    await buildBridge({
      chatModeRuntime: makeRuntime({
        toolServerPreferences: { srv: { approvalMode: 'full_access' } },
      }),
    })

    expect(gatewayOptions()).toEqual(
      expect.objectContaining({
        advertisesAllToolSchemas: true,
        toolServerPreferences: { srv: { approvalMode: 'full_access' } },
      }),
    )
  })

  it('drops conversation-dependent built-ins from the declarations', async () => {
    const excludedFqn = getToolNamesForCapability('context_compaction')[0]
    const mcpManager = makeMcpManager()
    mcpManager.listAvailableTools.mockResolvedValue([
      fsReadTool,
      {
        name: excludedFqn,
        description: 'Compact',
        inputSchema: { type: 'object' },
      },
    ])
    installGateway(makeGateway())
    const bridge = await buildBridge({
      mcpManager,
      chatModeRuntime: makeRuntime({
        allowedToolNames: [fsReadTool.name, excludedFqn],
      }),
    })

    expect(bridge.declarations.map((declaration) => declaration.name)).toEqual([
      'fs_read',
    ])
  })

  it('hands the gateway the same boundary the text agent runs under', async () => {
    installGateway(makeGateway())
    await buildBridge({
      assistant: {
        id: 'a1',
        workspaceScope: { enabled: true, include: ['ref/'], exclude: [] },
      },
      settings: {
        ...makeSettings(),
        mcp: {
          servers: [],
          discoveredCatalogs: {},
          builtinCapabilityOptions: {
            terminal: { blockedPrefixes: ['rm -rf'] },
          },
        },
      },
    })

    expect(gatewayOptions()).toEqual(
      expect.objectContaining({
        workspaceScope: { enabled: true, include: ['ref/'], exclude: [] },
        allowedSkillPaths: ['Skills/pkg/SKILL.md'],
        blockedCommandPrefixes: ['rm -rf'],
      }),
    )
  })

  it('drops the assistant boundary in a module chat mode', async () => {
    installGateway(makeGateway())
    await buildBridge({
      assistant: {
        id: 'a1',
        workspaceScope: { enabled: true, include: ['ref/'], exclude: [] },
      },
      chatModeRuntime: makeRuntime({ moduleChatModeId: 'mod:mode' }),
    })

    expect(gatewayOptions()).toEqual(
      expect.objectContaining({
        workspaceScope: undefined,
        allowedSkillPaths: [],
      }),
    )
  })

  it('is inert when voice tools are disabled', async () => {
    installGateway(makeGateway())
    const mcpManager = makeMcpManager()
    const bridge = await buildBridge({
      mcpManager,
      settings: makeSettings(false),
    })

    expect(bridge.declarations).toEqual([])
    expect(await bridge.handleFunctionCalls([{ name: 'fs_read' }])).toEqual([])
    expect(mcpManager.listAvailableTools).not.toHaveBeenCalled()
    expect(gatewayConstructor).not.toHaveBeenCalled()
  })

  it('carries the shared chat prompt as the session system prompt', async () => {
    installGateway(makeGateway())
    const requestContextBuilder = makeRequestContextBuilder('SHARED PROMPT')
    const bridge = await buildBridge({ requestContextBuilder })

    expect(bridge.systemPrompt).toBe('SHARED PROMPT')
    expect(requestContextBuilder.generateSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        hasTools: true,
        hasOnDemandTools: false,
        systemPromptSnapshotMode: 'reuse',
      }),
    )
  })

  it('appends the voice addendum after the shared prompt', async () => {
    installGateway(makeGateway())
    const bridge = await buildBridge({
      settings: {
        ...makeSettings(),
        voice: { toolsEnabled: true, systemPrompt: '  Speak briefly.  ' },
      },
    })

    expect(bridge.systemPrompt).toBe('SHARED PROMPT\n\nSpeak briefly.')
  })

  it('keeps the shared prompt even when tools are off, with hasTools false', async () => {
    installGateway(makeGateway())
    const requestContextBuilder = makeRequestContextBuilder()
    const bridge = await buildBridge({
      requestContextBuilder,
      settings: makeSettings(false),
    })

    expect(bridge.systemPrompt).toBe('SHARED PROMPT')
    expect(requestContextBuilder.generateSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ hasTools: false }),
    )
  })

  it('forwards the mode runtime facts into the shared prompt', async () => {
    installGateway(makeGateway())
    const requestContextBuilder = makeRequestContextBuilder()
    await buildBridge({
      requestContextBuilder,
      chatModeRuntime: makeRuntime({
        runtimeMode: 'max',
        modeEnvironmentPrompt: 'cwd: /vault',
        modePersonaPrompt: 'persona',
        modePersonaModuleId: 'mod',
        moduleChatModeId: 'mod:mode',
      }),
    })

    expect(requestContextBuilder.generateSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        hasTools: true,
        modeEnvironmentPrompt: 'cwd: /vault',
        modePersonaPrompt: 'persona',
        modePersonaModuleId: 'mod',
        moduleChatModeId: 'mod:mode',
        contextPolicy: { useAssistant: true },
      }),
    )
  })
})
