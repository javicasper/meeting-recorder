import { Icon } from './Icon.jsx'
import { MediaPlayer } from './MediaPlayer.jsx'
import { TranscriptionProgress } from './TranscriptionProgress.jsx'
import { InsightsPanel } from './InsightsPanel.jsx'
import { formatClock, formatDateTime, formatSize } from '../lib/format.js'

export function RecordingItem({
  recording,
  transcription,
  progress,
  processingTitle,
  showTranscript,
  isTranscribing,
  isRegenerating,
  isDownloadingPackage,
  isInsightsActive,
  onTranscribe,
  onRegenerate,
  onDownloadPackage,
  onDelete,
  onToggleTranscript,
}) {
  const hasTranscription = Boolean(transcription)

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
            {processingTitle || recording.displayTitle || recording.name}
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
            disabled={isDownloadingPackage || !hasTranscription}
            onClick={() => onDownloadPackage(recording)}
            title={
              hasTranscription
                ? 'Descargar ZIP (transcripción + resumen)'
                : 'Transcribe primero para generar el ZIP'
            }
            aria-label={
              hasTranscription
                ? 'Descargar ZIP de la reunión'
                : 'Descargar ZIP deshabilitado: falta transcripción'
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

      <TranscriptionProgress progress={progress} />

      <MediaPlayer
        kind={recording.mediaKind}
        src={recording.url}
        fallbackDurationSeconds={recording.durationSeconds}
      />

      {isInsightsActive && hasTranscription && (
        <InsightsPanel
          recordingId={recording.id}
          transcription={transcription}
          regenerating={isRegenerating}
          onRegenerate={() => onRegenerate(recording)}
          showTranscript={showTranscript}
          onToggleTranscript={() => onToggleTranscript(recording.id)}
        />
      )}
    </li>
  )
}
