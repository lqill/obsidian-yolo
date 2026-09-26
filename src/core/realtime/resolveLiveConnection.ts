// src/core/realtime/resolveLiveConnection.ts
import type { YoloSettings } from '../../settings/schema/setting.types'
import { DEFAULT_VOICE_SETTINGS } from '../../settings/schema/setting.types'
import {
  getDefaultBaseUrlForPreset,
  normalizeGeminiProviderBaseUrl,
} from '../../utils/llm/provider-base-url'
import { getProviderById } from '../../utils/llm/provider-config'

export type ResolvedLiveConnection = {
  baseUrl: string
  apiKey: string
  model: string
  voiceName: string
}

/**
 * Why a Live session cannot start. Core reports the reason; the UI owns the
 * wording (i18n), so no user-visible string lives here.
 */
export type LiveConnectionFailure =
  | 'no_provider'
  /** Selected provider is not a Gemini API-key provider (OAuth is unsupported). */
  | 'not_gemini'
  | 'no_api_key'
  | 'no_model'
  /** The Live API is served from Google's endpoint only; proxies cannot carry it. */
  | 'custom_base_url'

export type LiveConnectionResolution =
  | { ok: true; value: ResolvedLiveConnection }
  | { ok: false; reason: LiveConnectionFailure }

const FALLBACK_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

export const resolveLiveConnection = ({
  settings,
}: {
  settings: YoloSettings
}): LiveConnectionResolution => {
  const { voice } = settings
  const provider = voice.providerId
    ? getProviderById(settings, voice.providerId)
    : undefined
  if (!provider) {
    return { ok: false, reason: 'no_provider' }
  }
  if (provider.presetType !== 'gemini') {
    return { ok: false, reason: 'not_gemini' }
  }
  if (!provider.apiKey) {
    return { ok: false, reason: 'no_api_key' }
  }
  const model = voice.model.trim()
  if (!model) {
    return { ok: false, reason: 'no_model' }
  }

  const defaultBaseUrl = normalizeGeminiProviderBaseUrl(
    getDefaultBaseUrlForPreset('gemini') ?? FALLBACK_GEMINI_BASE_URL,
  )
  const baseUrl = normalizeGeminiProviderBaseUrl(
    provider.baseUrl?.trim() || defaultBaseUrl,
  )
  if (baseUrl !== defaultBaseUrl) {
    return { ok: false, reason: 'custom_base_url' }
  }

  return {
    ok: true,
    value: {
      baseUrl,
      apiKey: provider.apiKey,
      model,
      voiceName: voice.voiceName.trim() || DEFAULT_VOICE_SETTINGS.voiceName,
    },
  }
}
