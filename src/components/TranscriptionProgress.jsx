const clampPercent = (value) => Math.max(0, Math.min(100, Number(value || 0)))

export function TranscriptionProgress({ progress }) {
  if (!progress?.status || progress.status === 'done') return null

  const percent = clampPercent(progress.progress_percent)
  const chunkCount = Number(progress.chunk_count || 0)
  const processedChunks = Number(progress.processed_chunks || 0)

  return (
    <div className="transcriptionProgress">
      <div className="transcriptionProgressTop">
        <span>{progress.stage_label || 'Procesando...'}</span>
        <span>{percent}%</span>
      </div>
      <div className="transcriptionProgressBar">
        <span style={{ width: `${percent}%` }} />
      </div>
      {chunkCount > 0 && (
        <p className="transcriptionProgressMeta">
          Bloques: {processedChunks}/{chunkCount}
        </p>
      )}
    </div>
  )
}
