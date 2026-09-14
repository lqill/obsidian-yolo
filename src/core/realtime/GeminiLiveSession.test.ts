// src/core/realtime/GeminiLiveSession.test.ts
import { GeminiLiveSession } from './GeminiLiveSession'
import type { GeminiLiveServerEvent } from './geminiLiveProtocol'
import { voiceSessionStore } from './voiceSessionStore'

type Microphone = {
  start(onFrame: (base64: string) => void, onLevel: (level: number) => void): Promise<void>
  stop(): void
  setMuted(muted: boolean): void
}

const makeFakes = () => {
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
    isOpen: true,
  }
  const turns: Array<{ userText: string; assistantText: string }> = []
  const session = new GeminiLiveSession({
    client: client as any,
    microphone: microphone as any,
    player: player as any,
    store: voiceSessionStore,
    onTurn: (turn) => turns.push(turn),
  })
  return { session, client, microphone, player, turns }
}

describe('GeminiLiveSession per-turn state machine', () => {
  beforeEach(() => voiceSessionStore.reset())

  it('commits exactly once and ignores a post-interrupted turnComplete', () => {
    const { session, turns } = makeFakes()
    session.start()
    session.handleEvent({ kind: 'inputTranscript', text: 'hello' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'outputTranscript', text: 'partial' } as GeminiLiveServerEvent)
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
    session.handleEvent({ kind: 'inputTranscript', text: 'spoken' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'outputTranscript', text: 'reply' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([{ userText: 'typed\nspoken', assistantText: 'reply' }])
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
    session.handleEvent({ kind: 'inputTranscript', text: 'first question' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'outputTranscript', text: 'first answer' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    session.handleEvent({ kind: 'inputTranscript', text: 'second question' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'outputTranscript', text: 'second answer' } as GeminiLiveServerEvent)
    session.handleEvent({ kind: 'turnComplete' })
    expect(turns).toEqual([
      { userText: 'first question', assistantText: 'first answer' },
      { userText: 'second question', assistantText: 'second answer' },
    ])
  })
})
