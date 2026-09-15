import { useSyncExternalStore } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { voiceSessionStore } from '../../../core/realtime/voiceSessionStore'

export const VoiceControlBar = ({
  onToggleMute,
  onEnd,
}: {
  onToggleMute: () => void
  onEnd: () => void
}) => {
  const { t } = useLanguage()
  const snapshot = useSyncExternalStore(
    voiceSessionStore.subscribe,
    voiceSessionStore.getSnapshot,
    voiceSessionStore.getSnapshot,
  )
  if (snapshot.status === 'idle') return null
  return (
    <div className="yolo-voice-control-bar">
      <span className="yolo-voice-control-bar__status">
        {snapshot.status === 'connecting'
          ? t('voiceStatusConnecting')
          : snapshot.status === 'error'
            ? `${t('voiceStatusError')}: ${snapshot.error ?? ''}`
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
      <div className="yolo-voice-control-bar__captions">
        <div className="yolo-voice-control-bar__caption">
          {snapshot.partialUserText}
        </div>
        <div className="yolo-voice-control-bar__caption">
          {snapshot.partialAssistantText}
        </div>
      </div>
      <button type="button" onClick={onToggleMute}>
        {snapshot.muted ? t('voiceUnmute') : t('voiceMute')}
      </button>
      <button type="button" onClick={onEnd}>
        {t('voiceEnd')}
      </button>
    </div>
  )
}
