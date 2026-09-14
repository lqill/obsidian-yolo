import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { voiceSessionStore } from '../../../core/realtime/voiceSessionStore'

import { ChatModeSelect } from './ChatModeSelect'

describe('ChatModeSelect voice lock', () => {
  afterEach(() => voiceSessionStore.reset())

  it('leaves the trigger enabled while voice is idle', () => {
    const html = renderToStaticMarkup(
      <ChatModeSelect
        mode="agent"
        onChange={() => {}}
        yoloByMode={{}}
        onYoloChange={() => {}}
      />,
    )

    expect(html).not.toContain('disabled')
  })

  it('disables the trigger while a voice session is active', () => {
    voiceSessionStore.setStatus('connecting')

    const html = renderToStaticMarkup(
      <ChatModeSelect
        mode="agent"
        onChange={() => {}}
        yoloByMode={{}}
        onYoloChange={() => {}}
      />,
    )

    expect(html).toContain('disabled=""')
  })
})
