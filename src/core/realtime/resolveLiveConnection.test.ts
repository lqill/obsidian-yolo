// src/core/realtime/resolveLiveConnection.test.ts
import { resolveLiveConnection } from './resolveLiveConnection'

const base = {
  providers: [
    { id: 'g1', presetType: 'gemini', apiType: 'gemini', apiKey: 'k1' },
    { id: 'g2', presetType: 'gemini-oauth', apiType: 'gemini', apiKey: 'k2' },
    { id: 'o1', presetType: 'openai', apiType: 'openai-compatible', apiKey: 'k3' },
  ],
  voice: { providerId: 'g1', model: 'gemini-3.1-flash-live-preview', voiceName: 'Kore', systemPrompt: 'Hi' },
} as any

describe('resolveLiveConnection', () => {
  it('resolves a Gemini API-key provider', () => {
    expect(resolveLiveConnection({ settings: base })).toEqual({
      ok: true,
      value: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'k1',
        model: 'gemini-3.1-flash-live-preview',
        voiceName: 'Kore',
        systemPrompt: 'Hi',
      },
    })
  })

  it('rejects a gemini-oauth provider (apiType is also gemini)', () => {
    const settings = { ...base, voice: { ...base.voice, providerId: 'g2' } }
    const result = resolveLiveConnection({ settings })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/API key/)
  })

  it('errors when no provider is selected', () => {
    const settings = { ...base, voice: { ...base.voice, providerId: undefined } }
    const result = resolveLiveConnection({ settings })
    expect(result.ok).toBe(false)
  })

  it('errors when the API key is empty', () => {
    const settings = {
      ...base,
      providers: [{ id: 'g1', presetType: 'gemini', apiType: 'gemini', apiKey: '' }],
    }
    const result = resolveLiveConnection({ settings })
    expect(result.ok).toBe(false)
  })
})
