/* eslint-disable import/order -- the CLI test module's hoisted jest.mock calls must register before ChatUserInput is evaluated */
import { renderToStaticMarkup } from 'react-dom/server'

import { Platform } from 'obsidian'

import { createChatUserInputProps } from './ChatUserInput.cli.test'
import ChatUserInput from './ChatUserInput'

const platform = Platform as unknown as { isDesktop: boolean }

describe('ChatUserInput voice toggle', () => {
  it('hides the mic button on mobile', () => {
    platform.isDesktop = false
    const html = renderToStaticMarkup(
      <ChatUserInput
        {...createChatUserInputProps({
          isVoiceActive: false,
          onToggleVoice: jest.fn(),
        })}
      />,
    )
    expect(html).not.toContain('yolo-chat-input-voice-toggle')
  })

  it('shows the mic button on desktop', () => {
    platform.isDesktop = true
    const html = renderToStaticMarkup(
      <ChatUserInput
        {...createChatUserInputProps({
          isVoiceActive: false,
          onToggleVoice: jest.fn(),
        })}
      />,
    )
    expect(html).toContain('yolo-chat-input-voice-toggle')
    expect(html).toContain('voiceMicStart')
  })
})
