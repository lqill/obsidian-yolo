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
})
