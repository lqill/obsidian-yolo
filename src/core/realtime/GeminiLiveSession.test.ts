// src/core/realtime/GeminiLiveSession.test.ts
import type {
  GeminiLiveHistoryTurn,
  GeminiLiveServerEvent,
} from './geminiLiveProtocol'
import { GeminiLiveSession } from './GeminiLiveSession'
import { voiceSessionStore } from './voiceSessionStore'

type ToolHandler = (
  calls: Array<{ id?: string; name: string; args?: Record<string, unknown> }>,
) => Promise<
  Array<{ id?: string; name: string; response: Record<string, unknown> }>
>

const makeFakes = (overrides?: {
  toolHandler?: ToolHandler
  initialHistory?: GeminiLiveHistoryTurn[]
  onTurnOpen?: () => void
}) => {
  const microphone = {
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
    sendInitialHistory: jest.fn(),
    sendToolResponse: jest.fn(),
  }
  const turns: Array<{ userText: string; assistantText: string }> = []
  const session = new GeminiLiveSession({
    client: client as any,
    microphone: microphone as any,
    player: player as any,
    store: voiceSessionStore,
    onTurn: (turn) => turns.push(turn),
    onTurnOpen: overrides?.onTurnOpen,
    toolHandler: overrides?.toolHandler,
    initialHistory: overrides?.initialHistory,
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

  it('signals each turn open exactly once, before any of its text', () => {
    const opened: string[] = []
    const { session } = makeFakes({
      onTurnOpen: () =>
        opened.push(voiceSessionStore.getSnapshot().partialUserText),
    })
    session.start()
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'first',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'inputTranscript',
      text: ' question',
    } as GeminiLiveServerEvent)
    session.handleEvent({
      kind: 'outputTranscript',
      text: 'answer',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    session.handleEvent({
      kind: 'inputTranscript',
      text: 'second',
    } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })

    // Once per turn, and the store is still textless at that moment: the
    // caller creates the turn's messages before the transcript lands in them.
    expect(opened).toEqual(['', ''])
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
    expect(toolHandler).toHaveBeenCalledWith(
      [{ id: '1', name: 'fs_read', args: { path: 'a.md' } }],
      expect.any(AbortSignal),
    )
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
    expect(voiceSessionStore.getSnapshot().error).toEqual({
      failure: 'tools_unavailable',
      detail: 'boom',
    })
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

describe('GeminiLiveSession initial history', () => {
  beforeEach(() => voiceSessionStore.reset())

  it('opens the microphone immediately when there is no history', async () => {
    const { session, microphone, client } = makeFakes()
    await session.start()
    expect(microphone.start).toHaveBeenCalledTimes(1)
    expect(client.sendInitialHistory).not.toHaveBeenCalled()
  })

  it('replays history on ready before opening the microphone', async () => {
    const history: GeminiLiveHistoryTurn[] = [
      { role: 'user', text: 'earlier question' },
      { role: 'model', text: 'earlier answer' },
    ]
    const { session, microphone, client } = makeFakes({
      initialHistory: history,
    })
    await session.start()
    expect(microphone.start).not.toHaveBeenCalled()
    session.handleEvent({ kind: 'ready' })
    await flushAsync()
    expect(client.sendInitialHistory).toHaveBeenCalledWith(history)
    expect(microphone.start).toHaveBeenCalledTimes(1)
  })

  it('replays the turns it was given, and only those', async () => {
    const history: GeminiLiveHistoryTurn[] = [
      { role: 'user', text: 'real question' },
    ]
    const { session, client } = makeFakes({ initialHistory: history })
    await session.start()
    session.handleEvent({ kind: 'ready' })
    await flushAsync()
    expect(client.sendInitialHistory).toHaveBeenCalledWith(history)
  })

  it('surfaces a microphone failure after history replay', async () => {
    const { session, microphone } = makeFakes({
      initialHistory: [{ role: 'user', text: 'real question' }],
    })
    ;(microphone.start as jest.Mock).mockRejectedValueOnce(new Error('denied'))
    await session.start()
    session.handleEvent({ kind: 'ready' })
    await flushAsync()
    expect(voiceSessionStore.getSnapshot().status).toBe('error')
    expect(voiceSessionStore.getSnapshot().error).toEqual({
      failure: 'mic_unavailable',
      detail: 'denied',
    })
  })

  it('does not replay history after stop', async () => {
    const { session, client } = makeFakes({
      initialHistory: [{ role: 'user', text: 'earlier' }],
    })
    await session.start()
    session.stop()
    session.handleEvent({ kind: 'ready' })
    await flushAsync()
    expect(client.sendInitialHistory).not.toHaveBeenCalled()
  })
})
