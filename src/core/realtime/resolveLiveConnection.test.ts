// src/core/realtime/resolveLiveConnection.test.ts
import { resolveLiveConnection } from './resolveLiveConnection'

const base = {
  providers: [
    { id: 'g1', presetType: 'gemini', apiType: 'gemini', apiKey: 'k1' },
    { id: 'g2', presetType: 'gemini-oauth', apiType: 'gemini', apiKey: 'k2' },
    {
      id: 'o1',
      presetType: 'openai',
      apiType: 'openai-compatible',
      apiKey: 'k3',
    },
    {
      id: 'g3',
      presetType: 'gemini',
      apiType: 'gemini',
      apiKey: 'k4',
      baseUrl: 'https://proxy.example.com',
    },
  ],
  voice: {
    providerId: 'g1',
    model: 'gemini-3.1-flash-live-preview',
    voiceName: 'Kore',
    systemPrompt: 'Hi',
  },
} as any

const reasonFor = (settings: unknown): string => {
  const result = resolveLiveConnection({ settings: settings as any })
  return result.ok ? 'ok' : result.reason
}

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

  it('normalizes the provider base URL before comparing it to the default', () => {
    const settings = {
      ...base,
      providers: [
        {
          ...base.providers[0],
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
        },
      ],
    }
    const result = resolveLiveConnection({ settings })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.baseUrl).toBe(
        'https://generativelanguage.googleapis.com',
      )
    }
  })

  it('rejects a custom base URL (the Live API is not served from proxies)', () => {
    const settings = { ...base, voice: { ...base.voice, providerId: 'g3' } }
    expect(reasonFor(settings)).toBe('custom_base_url')
  })

  it('rejects a gemini-oauth provider (apiType is also gemini)', () => {
    const settings = { ...base, voice: { ...base.voice, providerId: 'g2' } }
    expect(reasonFor(settings)).toBe('not_gemini')
  })

  it('rejects a non-Gemini provider', () => {
    const settings = { ...base, voice: { ...base.voice, providerId: 'o1' } }
    expect(reasonFor(settings)).toBe('not_gemini')
  })

  it('errors when no provider is selected', () => {
    const settings = {
      ...base,
      voice: { ...base.voice, providerId: undefined },
    }
    expect(reasonFor(settings)).toBe('no_provider')
  })

  it('errors when the API key is empty', () => {
    const settings = {
      ...base,
      providers: [
        { id: 'g1', presetType: 'gemini', apiType: 'gemini', apiKey: '' },
      ],
    }
    expect(reasonFor(settings)).toBe('no_api_key')
  })

  it('errors when the model is empty', () => {
    const settings = { ...base, voice: { ...base.voice, model: '  ' } }
    expect(reasonFor(settings)).toBe('no_model')
  })
})
