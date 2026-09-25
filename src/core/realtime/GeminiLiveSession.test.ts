// src/core/realtime/GeminiLiveSession.test.ts
import type { GeminiLiveServerEvent } from './geminiLiveProtocol'
import { GeminiLiveSession } from './GeminiLiveSession'
import { voiceSessionStore } from './voiceSessionStore'

type Microphone = {
  start(): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
}

type ToolHandler = (
  calls: Array<{ id?: string; name: string; args?: Record<string, unknown> }>,
) => Promise<
  Array<{ id?: string; name: string; response: Record<string, unknown> }>
>

const makeFakes = (overrides?: { toolHandler?: ToolHandler }) => {
  const microphone: Microphone = {
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    setMuted: jest.fn(),
  }
  const player = { enqueue: jest.fn(), flush: jest.fn(), dispose: jest.fn() }
  const client = {
    connect: jest.fn(),
    close: jest.fn(),
    sendText: jest.fn(),
    sendAudio: jest.fn(),
    sendAudioStreamEnd: jest.fn(),
    sendToolResponse: jest.fn(),
  }
  const turns: Array<{ userText: string; assistantText: string }> = []
  const session = new GeminiLiveSession({
    client: client as any,
    microphone: microphone as any,
    player: player as any,
    store: voiceSessionStore,
    onTurn: (turn) => turns.push(turn),
    toolHandler: overrides?.toolHandler,
  })
  return { session, client, microphone, player, turns }
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('GeminiLiveSession per-turn state machine', () => {
  beforeEach(() => voiceSessionStore.reset())

  it('commits exactly once and ignores a post-interrupted turnComplete', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'hello',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'outputTranscript',
      text: 'partial',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'interrupted' })
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([{ userText: 'hello', assistantText: 'partial' }])
  })

  it('skips all-empty turns', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.handleEvent({ kind: 'interrupted' })
    expect(turns).toEqual([])
  })

  it('combines typed text with spoken transcript', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.sendText('typed')
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'spoken',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'outputTranscript',
      text: 'reply',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([
      { userText: 'typed\nspoken', assistantText: 'reply' },
    ])
  })

  it('ignores turnComplete without user input', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([])
  })

  it('commits two consecutive spoken-only turns', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'first question',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'outputTranscript',
      text: 'first answer',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'second question',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'outputTranscript',
      text: 'second answer',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([
      { userText: 'first question', assistantText: 'first answer' },
      { userText: 'second question', assistantText: 'second answer' },
    ])
  })

  it('forwards tool calls to the handler and sends the responses', async () => {
    const toolHandler = jest.fn(async () => [
      { id: '1', name: 'fs_read', response: { result: 'ok' } },
    ])
    const { session, client } = makeFakes({ toolHandler })
    session.start()
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ id: '1', name: 'fs_read', args: { path: 'a.md' } }],
    } as GeminiLiveServerEvent)
    await flushAsync()
    expect(toolHandler).toHaveBeenCalledWith([
      { id: '1', name: 'fs_read', args: { path: 'a.md' } },
    ])
    expect(client.sendToolResponse).toHaveBeenCalledWith([
      { id: '1', name: 'fs_read', response: { result: 'ok' } },
    ])
  })

  it('ignores tool calls when no handler is configured', () => {
    const { session, client } = makeFakes()
    session.start()
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ name: 'fs_read' }],
    } as GeminiLiveServerEvent)
    expect(client.sendToolResponse).not.toHaveBeenCalled()
  })

  it('answers a handler failure with an error response so the model is not left waiting', async () => {
    const toolHandler = jest.fn(async () => {
      throw new Error('boom')
    })
    const { session, client } = makeFakes({ toolHandler })
    session.start()
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ id: '1', name: 'fs_read' }],
    } as GeminiLiveServerEvent)
    await flushAsync()
    expect(voiceSessionStore.getSnapshot().error).toBe('boom')
    expect(voiceSessionStore.getSnapshot().activeToolName).toBeNull()
    expect(client.sendToolResponse).toHaveBeenCalledWith([
      { id: '1', name: 'fs_read', response: { error: 'boom' } },
    ])
  })

  it('serializes overlapping tool-call batches in arrival order', async () => {
    const releases: Array<() => void> = []
    const toolHandler = jest.fn(
      (calls: Array<{ id?: string; name: string }>) =>
        new Promise<
          Array<{
            id?: string
            name: string
            response: Record<string, unknown>
          }>
        >((resolve) => {
          releases.push(() =>
            resolve([
              {
                id: calls[0].id,
                name: calls[0].name,
                response: { result: calls[0].name },
              },
            ]),
          )
        }),
    )
    const { session, client } = makeFakes({ toolHandler })
    session.start()
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ id: '1', name: 'fs_read' }],
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ id: '2', name: 'fs_write' }],
    } as GeminiLiveServerEvent)
    // Only the first batch may be in flight; the second waits its turn.
    await flushAsync()
    expect(toolHandler).toHaveBeenCalledTimes(1)
    releases[0]()
    await flushAsync()
    expect(toolHandler).toHaveBeenCalledTimes(2)
    releases[1]()
    await flushAsync()
    expect(
      client.sendToolResponse.mock.calls.map(
        ([responses]) => responses[0].name,
      ),
    ).toEqual(['fs_read', 'fs_write'])
  })

  it('does not send a tool response after stop', async () => {
    const pending: { resolve: (() => void) | null } = { resolve: null }
    const toolHandler = jest.fn(
      () =>
        new Promise<
          Array<{
            id?: string
            name: string
            response: Record<string, unknown>
          }>
        >((resolve) => {
          pending.resolve = () =>
            resolve([{ name: 'fs_read', response: { result: 'ok' } }])
        }),
    )
    const { session, client } = makeFakes({ toolHandler })
    session.start()
    session.handleEvent({
      kind: 'toolCall',
      functionCalls: [{ name: 'fs_read' }],
    } as GeminiLiveServerEvent)
    session.stop()
    pending.resolve?.()
    await flushAsync()
    expect(client.sendToolResponse).not.toHaveBeenCalled()
  })
})
