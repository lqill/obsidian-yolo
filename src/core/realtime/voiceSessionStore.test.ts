// src/core/realtime/voiceSessionStore.test.ts
import { voiceSessionStore } from './voiceSessionStore'

describe('voiceSessionStore', () => {
  beforeEach(() => voiceSessionStore.reset())

  it('starts idle with no captions', () => {
    expect(voiceSessionStore.getSnapshot().status).toBe('idle')
    expect(voiceSessionStore.getSnapshot().partialUserText).toBe('')
  })

  it('notifies subscribers and returns a new snapshot reference on change', () => {
    const listener = jest.fn()
    const unsubscribe = voiceSessionStore.subscribe(listener)
    const before = voiceSessionStore.getSnapshot()
    voiceSessionStore.setStatus('connecting')
    expect(listener).toHaveBeenCalled()
    expect(voiceSessionStore.getSnapshot()).not.toBe(before)
    expect(voiceSessionStore.getSnapshot().status).toBe('connecting')
    unsubscribe()
  })

  it('accumulates partial transcripts and clears them on turn end', () => {
    voiceSessionStore.appendPartialUser('hello')
    voiceSessionStore.appendPartialUser(' world')
    expect(voiceSessionStore.getSnapshot().partialUserText).toBe('hello world')
    voiceSessionStore.clearPartials()
    expect(voiceSessionStore.getSnapshot().partialUserText).toBe('')
  })

  it('tracks and clears the active tool name', () => {
    expect(voiceSessionStore.getSnapshot().activeToolName).toBeNull()
    voiceSessionStore.setActiveTool('fs_read')
    expect(voiceSessionStore.getSnapshot().activeToolName).toBe('fs_read')
    voiceSessionStore.setActiveTool(null)
    expect(voiceSessionStore.getSnapshot().activeToolName).toBeNull()
  })

  it('clears the active tool on reset', () => {
    voiceSessionStore.setActiveTool('fs_read')
    voiceSessionStore.reset()
    expect(voiceSessionStore.getSnapshot().activeToolName).toBeNull()
  })

  it('tracks the live turn and clears it on reset', () => {
    expect(voiceSessionStore.getSnapshot().liveTurn).toBeNull()
    const liveTurn = {
      conversationId: 'c1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
    }
    voiceSessionStore.setLiveTurn(liveTurn)
    expect(voiceSessionStore.getSnapshot().liveTurn).toEqual(liveTurn)
    voiceSessionStore.reset()
    expect(voiceSessionStore.getSnapshot().liveTurn).toBeNull()
  })

  it('wakes partial-text subscribers only when that role’s text changes', () => {
    const userListener = jest.fn()
    const assistantListener = jest.fn()
    const unsubscribeUser = voiceSessionStore.subscribePartialText(
      'user',
      userListener,
    )
    const unsubscribeAssistant = voiceSessionStore.subscribePartialText(
      'assistant',
      assistantListener,
    )

    // The mic meter writes to the same store at frame cadence; a text consumer
    // must not be woken by it.
    voiceSessionStore.setMicLevel(0.5)
    voiceSessionStore.setStatus('ready')
    expect(userListener).not.toHaveBeenCalled()
    expect(assistantListener).not.toHaveBeenCalled()

    voiceSessionStore.appendPartialUser('hi')
    expect(userListener).toHaveBeenCalledTimes(1)
    expect(assistantListener).not.toHaveBeenCalled()
    expect(voiceSessionStore.getPartialText('user')).toBe('hi')

    voiceSessionStore.appendPartialAssistant('yo')
    expect(assistantListener).toHaveBeenCalledTimes(1)
    expect(userListener).toHaveBeenCalledTimes(1)
    expect(voiceSessionStore.getPartialText('assistant')).toBe('yo')

    unsubscribeUser()
    unsubscribeAssistant()
    voiceSessionStore.appendPartialUser('!')
    expect(userListener).toHaveBeenCalledTimes(1)
    expect(voiceSessionStore.getPartialText('user')).toBe('hi!')
  })
})
