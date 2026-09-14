// src/core/realtime/resolveLiveConnection.ts
import type { YoloSettings } from '../../settings/schema/setting.types'
import { DEFAULT_GEMINI_BASE_URL } from '../llm/gemini'

export type ResolvedLiveConnection = {
  baseUrl: string
  apiKey: string
  model: string
  voiceName: string
  systemPrompt: string
}

export type LiveConnectionResolution =
  | { ok: true; value: ResolvedLiveConnection }
  | { ok: false; error: string }

export const resolveLiveConnection = ({
  settings,
}: {
  settings: YoloSettings
}): LiveConnectionResolution => {
  const voice = settings.voice
  const provider = settings.providers.find((candidate) => candidate.id === voice.providerId)
  if (!provider) {
    return { ok: false, error: 'Select a Gemini provider with an API key in Voice settings.' }
  }
  if (provider.presetType !== 'gemini') {
    return {
      ok: false,
      error: 'Voice mode requires a Gemini provider configured with an API key (OAuth is not supported yet).',
    }
  }
  if (!provider.apiKey) {
    return { ok: false, error: 'The selected Gemini provider has no API key.' }
  }
  if (!voice.model.trim()) {
    return { ok: false, error: 'Set a Live model in Voice settings.' }
  }
  const baseUrl = provider.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL
  return {
    ok: true,
    value: {
      baseUrl,
      apiKey: provider.apiKey,
      model: voice.model.trim(),
      voiceName: voice.voiceName.trim() || 'Kore',
      systemPrompt: voice.systemPrompt,
    },
  }
}
