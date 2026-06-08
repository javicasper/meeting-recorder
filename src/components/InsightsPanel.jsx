const ReportList = ({ title, items, render }) => {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="insightBlock">
      <h3>{title}</h3>
      <ul>{items.map(render)}</ul>
    </div>
  )
}

export function InsightsPanel({
  recordingId,
  transcription,
  regenerating,
  onRegenerate,
  showTranscript,
  onToggleTranscript,
}) {
  const report = transcription?.report || {}

  return (
    <section className="insightsPanel">
      <p className="insightsMeta">
        Modelo: {transcription.transcription_model || '-'} · Coste: $
        {Number(transcription.estimated_transcription_cost_usd || 0).toFixed(6)}
      </p>
      <p className="insightsSummary">{report.summary || 'Sin resumen'}</p>

      <ReportList
        title="Puntos clave"
        items={report.key_points}
        render={(item, idx) => <li key={`${recordingId}-kp-${idx}`}>{item}</li>}
      />

      <ReportList
        title="Temas tratados"
        items={report.topics}
        render={(topic, idx) => (
          <li key={`${recordingId}-topic-${idx}`}>
            <strong>{topic.title || `Tema ${idx + 1}`}</strong>: {topic.summary || ''}
          </li>
        )}
      />

      <ReportList
        title="Decisiones"
        items={report.decisions}
        render={(item, idx) => <li key={`${recordingId}-dec-${idx}`}>{item}</li>}
      />

      <ReportList
        title="Tareas"
        items={report.action_items}
        render={(item, idx) => (
          <li key={`${recordingId}-task-${idx}`}>
            <strong>{item.task || 'Tarea'}</strong>
            {item.owner ? ` · Responsable: ${item.owner}` : ''}
            {item.due_date ? ` · Fecha: ${item.due_date}` : ''}
          </li>
        )}
      />

      <ReportList
        title="Riesgos"
        items={report.risks}
        render={(item, idx) => <li key={`${recordingId}-risk-${idx}`}>{item}</li>}
      />

      <ReportList
        title="Preguntas abiertas"
        items={report.open_questions}
        render={(item, idx) => <li key={`${recordingId}-q-${idx}`}>{item}</li>}
      />

      <div className="insightsActions">
        <button
          type="button"
          className="historyRegenerate"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          {regenerating ? 'Rehaciendo resumen...' : 'Rehacer resumen'}
        </button>
        <button type="button" className="historyTranscribe" onClick={onToggleTranscript}>
          {showTranscript ? 'Ocultar transcripción' : 'Mostrar transcripción'}
        </button>
      </div>

      {showTranscript && (
        <p className="insightsTranscript">{transcription.transcript_text || 'Sin texto'}</p>
      )}
    </section>
  )
}
