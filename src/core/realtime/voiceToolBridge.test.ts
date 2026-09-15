// src/core/realtime/voiceToolBridge.test.ts
import { INVOKE_TOOL_NAME } from '../tools/internal/invoke_tool/definition'
import { getToolNamesForCapability } from '../tools/registry'
import {
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import {
  ToolCallResponseStatus,
  type ToolCallRequest,
} from '../../types/tool-call.types'
import {
  buildVoiceToolBridge,
  type VoiceToolGatewayLike,
} from './voiceToolBridge'

const localServer = getLocalFileToolServerName()
const invokeFqn = `${localServer}__${INVOKE_TOOL_NAME}`
const loadFqn = `${localServer}__${LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME}`

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
    mcp: { servers: [], discoveredCatalogs: {} },
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
): VoiceToolGatewayLike =>
  ({
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
  }) as unknown as VoiceToolGatewayLike

describe('buildVoiceToolBridge', () => {
  it('advertises enabled tools under model names, drops protocol wrappers, and sanitizes schemas', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(),
      createGateway: () => gateway,
    })

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
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(),
      createGateway: () => gateway,
    })

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

  it('rejects calls that would require interactive approval', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway({
      [`${localServer}__fs_read`]: {
        status: ToolCallResponseStatus.PendingApproval,
      },
    })
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(),
      createGateway: () => gateway,
    })

    const responses = await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_read', args: {} },
    ])

    expect(String(responses[0].response.error)).toMatch(/approval/i)
    const passedMessage = (gateway.executeAutoToolCalls as jest.Mock).mock
      .calls[0][0].toolMessage
    expect(passedMessage.toolCalls[0].response.status).toBe(
      ToolCallResponseStatus.Rejected,
    )
  })

  it('returns a response for every incoming call when the gateway merges entries', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    ;(gateway.executeAutoToolCalls as jest.Mock).mockResolvedValueOnce({
      role: 'tool',
      id: 'tm1',
      toolCalls: [],
    })
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(),
      createGateway: () => gateway,
    })

    const responses = await bridge.handleFunctionCalls([
      { id: 'call1', name: 'fs_read', args: {} },
      { id: 'call2', name: 'fs_read', args: {} },
    ])

    expect(responses).toHaveLength(2)
    expect(responses.every((response) => 'error' in response.response)).toBe(
      true,
    )
  })

  it('forces server disclosure to always so on-demand MCP tools are directly callable', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const createGateway = jest.fn(() => gateway)
    await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(),
      createGateway,
    })

    expect(createGateway).toHaveBeenCalledWith(
      mcpManager,
      expect.objectContaining({
        toolServerPreferences: { srv: { disclosureMode: 'always' } },
      }),
    )
  })

  it('preserves an existing server approvalMode while forcing always disclosure', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const createGateway = jest.fn(() => gateway)
    await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime({
        toolServerPreferences: { srv: { approvalMode: 'full_access' } },
      }),
      settings: makeSettings(),
      createGateway,
    })

    expect(createGateway).toHaveBeenCalledWith(
      mcpManager,
      expect.objectContaining({
        toolServerPreferences: {
          srv: { approvalMode: 'full_access', disclosureMode: 'always' },
        },
      }),
    )
  })

  it('drops conversation-dependent built-ins from the declarations', async () => {
    const excludedFqn = getToolNamesForCapability('context_compaction')[0]
    const mcpManager = makeMcpManager()
    ;(mcpManager.listAvailableTools as jest.Mock).mockResolvedValue([
      fsReadTool,
      {
        name: excludedFqn,
        description: 'Compact',
        inputSchema: { type: 'object' },
      },
    ])
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime({
        allowedToolNames: [fsReadTool.name, excludedFqn],
      }),
      settings: makeSettings(),
      createGateway: () => makeGateway(),
    })

    expect(bridge.declarations.map((declaration) => declaration.name)).toEqual([
      'fs_read',
    ])
  })

  it('promotes configured-but-offline servers as well as connected ones', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const createGateway = jest.fn(() => gateway)
    await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: {
        ...makeSettings(),
        mcp: { servers: [{ id: 'offline' }], discoveredCatalogs: {} },
      },
      createGateway,
    })

    expect(createGateway).toHaveBeenCalledWith(
      mcpManager,
      expect.objectContaining({
        toolServerPreferences: expect.objectContaining({
          srv: { disclosureMode: 'always' },
          offline: { disclosureMode: 'always' },
        }),
      }),
    )
  })

  it('is inert when voice tools are disabled', async () => {
    const mcpManager = makeMcpManager()
    const gateway = makeGateway()
    const bridge = await buildVoiceToolBridge({
      mcpManager,
      conversationId: 'c1',
      chatModeRuntime: makeRuntime(),
      settings: makeSettings(false),
      createGateway: () => gateway,
    })

    expect(bridge.declarations).toEqual([])
    expect(await bridge.handleFunctionCalls([{ name: 'fs_read' }])).toEqual([])
    expect(mcpManager.listAvailableTools).not.toHaveBeenCalled()
  })
})
