import { useEffect, useRef } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { VoiceFailure } from '../../../core/realtime'
import {
  getRealtimeMicLevel,
  subscribeRealtimeMicLevel,
  useRealtimeVoiceStatus,
} from '../../../core/realtime/useRealtimeVoice'

/** Core names the failure; the wording lives here, resolved at render time. */
const FAILURE_KEY: Record<VoiceFailure, string> = {
  no_provider: 'voiceUnavailable',
  not_gemini: 'voiceProviderUnsupported',
  no_api_key: 'voiceApiKeyMissing',
  no_model: 'voiceModelMissing',
  custom_base_url: 'voiceCustomBaseUrlUnsupported',
  insecure_context: 'voiceInsecureContext',
  audio_context_unsupported: 'voiceAudioContextUnsupported',
  audio_worklet_unsupported: 'voiceAudioWorkletUnsupported',
  mic_permission_denied: 'voiceMicPermissionDenied',
  audio_suspended: 'voiceAudioSuspended',
  mic_unavailable: 'voiceMicUnavailable',
  mic_lost: 'voiceMicLost',
  server: 'voiceStatusError',
  session_closed: 'voiceSessionClosed',
  tools_unavailable: 'voiceToolsUnavailable',
  start_failed: 'voiceStatusError',
}

/**
 * The mic meter, deliberately outside React's render path. `micLevel` is
 * written once per worklet render quantum — ~125+/s on Android, which a phone
 * cannot afford as full React renders — so the level goes straight onto the
 * node's `data-level`, which the stylesheet already keys its sweep and opacity
 * off. `data-level="0"` is the pre-effect value so the first paint matches a
 * silent microphone instead of showing the sweep.
 */
const VoiceLevelMeter = () => {
  const elementRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const write = (): void => {
      element.dataset.level = String(Math.round(getRealtimeMicLevel() * 100))
    }
    write()
    return subscribeRealtimeMicLevel(write)
  }, [])
  return (
    <div
      className="yolo-voice-control-bar__meter"
      data-level="0"
      ref={elementRef}
    />
  )
}

export const VoiceControlBar = ({
  onToggleMute,
  onEnd,
}: {
  onToggleMute: () => void
  onEnd: () => void
}) => {
  const { t } = useLanguage()
  // The coarse channel: status, mute, active tool, error. The level is on its
  // own channel so it cannot drag this component onto the frame cadence.
  const snapshot = useRealtimeVoiceStatus()
  if (snapshot.status === 'idle') return null
  const error = snapshot.error
  const errorText = error
    ? [t(FAILURE_KEY[error.failure]), error.detail].filter(Boolean).join(' — ')
    : ''
  return (
    <div className="yolo-voice-control-bar">
      <span className="yolo-voice-control-bar__status">
        {snapshot.status === 'connecting'
          ? t('voiceStatusConnecting')
          : snapshot.status === 'paused'
            ? t('voiceStatusPaused')
            : snapshot.status === 'error'
              ? errorText
              : t('voiceStatusReady')}
      </span>
      {snapshot.activeToolName ? (
        <span className="yolo-voice-control-bar__tool">
          {t('voiceToolRunning')}: {snapshot.activeToolName}
        </span>
      ) : null}
      <VoiceLevelMeter />
      <button type="button" onClick={onToggleMute}>
        {snapshot.muted ? t('voiceUnmute') : t('voiceMute')}
      </button>
      <button type="button" onClick={onEnd}>
        {t('voiceEnd')}
      </button>
    </div>
  )
}
