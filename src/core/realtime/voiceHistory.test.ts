// src/core/realtime/voiceHistory.test.ts
import type { ChatMessage } from '../../types/chat'

import {
  buildVoiceHistoryTurns,
  normalizeVoiceHistoryTurns,
} from './voiceHistory'

const user = (text: string): ChatMessage => ({
  role: 'user',
  id: `u-${text}`,
  content: null,
  promptContent: text,
  mentionables: [],
})

const assistant = (text: string): ChatMessage => ({
  role: 'assistant',
  id: `a-${text}`,
  content: text,
})

describe('buildVoiceHistoryTurns', () => {
  it('maps alternating user and assistant text turns in order', () => {
    expect(
      buildVoiceHistoryTurns([
        user('q1'),
        assistant('a1'),
        user('q2'),
        assistant('a2'),
      ]),
    ).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'model', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'model', text: 'a2' },
    ])
  })

  it('flattens structured prompt content, dropping non-text parts', () => {
    const message: ChatMessage = {
      role: 'user',
      id: 'u-structured',
      content: null,
      promptContent: [
        { type: 'text', text: 'look at ' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'this' },
      ],
      mentionables: [],
    }
    expect(buildVoiceHistoryTurns([message])).toEqual([
      { role: 'user', text: 'look at this' },
    ])
  })

  it('skips tool and result timeline entries and empty content', () => {
    const tool: ChatMessage = { role: 'tool', id: 't', toolCalls: [] }
    expect(
      buildVoiceHistoryTurns([
        user('only real message'),
        tool,
        assistant('   '),
      ]),
    ).toEqual([{ role: 'user', text: 'only real message' }])
  })

  it('merges consecutive same-role messages into one turn', () => {
    expect(
      buildVoiceHistoryTurns([
        user('first'),
        user('second'),
        assistant('reply'),
      ]),
    ).toEqual([
      { role: 'user', text: 'first\n\nsecond' },
      { role: 'model', text: 'reply' },
    ])
  })

  it('returns no turns for an empty conversation', () => {
    expect(buildVoiceHistoryTurns([])).toEqual([])
  })
})

describe('normalizeVoiceHistoryTurns', () => {
  it('trims turns and drops those left empty', () => {
    expect(
      normalizeVoiceHistoryTurns([
        { role: 'user', text: '  keep me  ' },
        { role: 'model', text: '   ' },
      ]),
    ).toEqual([{ role: 'user', text: 'keep me' }])
  })
})
