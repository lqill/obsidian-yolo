import { useLanguage } from '../../../contexts/language-context'
import type { VoiceFailure } from '../../../core/realtime'
import { useRealtimeVoiceSnapshot } from '../../../core/realtime/useRealtimeVoice'

/** Core names the failure; the wording lives here, resolved at render time. */
const FAILURE_KEY: Record<VoiceFailure, string> = {
  no_provider: 'voiceUnavailable',
  not_gemini: 'voiceProviderUnsupported',
  no_api_key: 'voiceApiKeyMissing',
  no_model: 'voiceModelMissing',
  custom_base_url: 'voiceCustomBaseUrlUnsupported',
  mic_unavailable: 'voiceMicUnavailable',
  server: 'voiceStatusError',
  session_closed: 'voiceSessionClosed',
  tools_unavailable: 'voiceToolsUnavailable',
  start_failed: 'voiceStatusError',
}

export const VoiceControlBar = ({
  onToggleMute,
  onEnd,
}: {
  onToggleMute: () => void
  onEnd: () => void
}) => {
  const { t } = useLanguage()
  const snapshot = useRealtimeVoiceSnapshot()
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
          : snapshot.status === 'error'
            ? errorText
            : t('voiceStatusReady')}
      </span>
      {snapshot.activeToolName ? (
        <span className="yolo-voice-control-bar__tool">
          {t('voiceToolRunning')}: {snapshot.activeToolName}
        </span>
      ) : null}
      <div
        className="yolo-voice-control-bar__meter"
        data-level={Math.round(snapshot.micLevel * 100)}
      />
      <button type="button" onClick={onToggleMute}>
        {snapshot.muted ? t('voiceUnmute') : t('voiceMute')}
      </button>
      <button type="button" onClick={onEnd}>
        {t('voiceEnd')}
      </button>
    </div>
  )
}
