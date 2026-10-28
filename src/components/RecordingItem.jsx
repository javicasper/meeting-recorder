import { useRef } from 'react'
import { Icon } from './Icon.jsx'
import { MediaPlayer } from './MediaPlayer.jsx'
import { InsightsPanel } from './InsightsPanel.jsx'
import { formatClock, formatDateTime, formatSize } from '../lib/format.js'

export function RecordingItem({
  recording,
  transcription,
  busyLabel,
  showTranscript,
  isInsightsActive,
  onTranscribe,
  onRegenerate,
  onDownloadNotes,
  onDelete,
  onToggleTranscript,
}) {
  const hasTranscription = Boolean(transcription)
  const mediaRef = useRef(null)

  const seekTo = (seconds) => {
    const media = mediaRef.current
    if (!media) return
    media.currentTime = seconds
    media.play().catch(() => {})
    media.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  const isTranscribing = Boolean(busyLabel)

  const transcribeTitle = isTranscribing
    ? 'Transcribiendo...'
    : hasTranscription
      ? isInsightsActive
        ? 'Ocultar datos'
        : 'Ver datos'
      : 'Transcribir'

  return (
    <li className="historyItem">
      <div className="historyTop">
        <div>
          <p className="historyTitle">
            {busyLabel || recording.displayTitle || recording.name}
          </p>
          <p className="historyMeta">
            {formatDateTime(recording.createdAt)} · {formatClock(recording.durationSeconds)} ·{' '}
            {formatSize(recording.sizeBytes)}
          </p>
        </div>
        <div className="historyActions">
          <a
            href={recording.url}
            download={recording.name}
            className="historyIconAction historyDownload"
            aria-label="Descargar grabación original"
            title="Descargar grabación original"
          >
            <Icon name="download" />
          </a>
          <button
            type="button"
            className="historyIconAction historyPackage"
            disabled={!hasTranscription}
            onClick={() => onDownloadNotes(recording)}
            title={
              hasTranscription
                ? 'Descargar acta (resumen + transcripción, Markdown)'
                : 'Transcribe primero para generar el acta'
            }
            aria-label={
              hasTranscription
                ? 'Descargar acta de la reunión'
                : 'Descargar acta deshabilitado: falta transcripción'
            }
          >
            <Icon name="archive" />
          </button>
          <button
            type="button"
            className="historyIconAction historyTranscribe"
            disabled={isTranscribing}
            onClick={() => onTranscribe(recording)}
            title={transcribeTitle}
            aria-label={isTranscribing ? 'Transcribiendo' : transcribeTitle}
          >
            <Icon name="eye" />
          </button>
          {hasTranscription && (
            <button
              type="button"
              className="historyIconAction historyRegenerate"
              disabled={isTranscribing}
              onClick={() => onTranscribe(recording, { force: true })}
              title="Regenerar transcripción y resumen"
              aria-label="Regenerar transcripción y resumen"
            >
              <Icon name="refresh" />
            </button>
          )}
          <button
            type="button"
            className="historyIconAction historyDelete"
            onClick={() => onDelete(recording)}
            title="Eliminar"
            aria-label="Eliminar"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <MediaPlayer
        kind={recording.mediaKind}
        src={recording.url}
        fallbackDurationSeconds={recording.durationSeconds}
        mediaRef={mediaRef}
        downmix={recording.audioChannels === 'mic-left-pc-right'}
      />

      {isInsightsActive && hasTranscription && (
        <InsightsPanel
          recordingId={recording.id}
          transcription={transcription}
          regenerating={isTranscribing}
          onRegenerate={() => onRegenerate(recording)}
          showTranscript={showTranscript}
          onToggleTranscript={() => onToggleTranscript(recording.id)}
          onSeek={seekTo}
        />
      )}
    </li>
  )
}
