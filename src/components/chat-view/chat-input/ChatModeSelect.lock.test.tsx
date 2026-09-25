import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { ChatModeSelect } from './ChatModeSelect'

describe('ChatModeSelect lock', () => {
  it('leaves the trigger enabled by default', () => {
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

  it('disables the trigger when the surface locks it', () => {
    const html = renderToStaticMarkup(
      <ChatModeSelect
        mode="agent"
        onChange={() => {}}
        yoloByMode={{}}
        onYoloChange={() => {}}
        disabled
      />,
    )

    expect(html).toContain('disabled=""')
  })
})
