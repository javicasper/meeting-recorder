// Pure formatting/helper functions shared across the UI.

export const formatClock = (totalSeconds) => {
  if (!Number.isFinite(totalSeconds)) return '00:00'

  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export const formatSize = (bytes) => {
  if (!bytes) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export const formatDateTime = (isoDate) =>
  new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(isoDate))

export const slugify = (value, fallback = '') => {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')

  return normalized || fallback
}

export const buildPackageFileName = (recording) => {
  const rawBase =
    recording.displayTitle ||
    recording.name.replace(/\.[^/.]+$/, '') ||
    `reunion-${recording.id}`

  return `${slugify(rawBase, 'reunion')}-paquete.zip`
}

export const buildTranscriptionKey = (recording) => {
  const safeId = String(recording.id || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
  const size = Number(recording.sizeBytes || 0)
  return `rec-${safeId}-${size}`
}

export const buildFullSummaryText = (report) => {
  if (!report || typeof report !== 'object') {
    return ''
  }

  const lines = []
  const pushLine = (value = '') => lines.push(String(value))

  const meetingTitle = String(report.meeting_title || '').trim()
  if (meetingTitle) {
    pushLine(`Título: ${meetingTitle}`)
    pushLine()
  }

  const executiveSummary = String(report.summary || '').trim()
  if (executiveSummary) {
    pushLine('Resumen ejecutivo:')
    pushLine(executiveSummary)
    pushLine()
  }

  const keyPoints = Array.isArray(report.key_points) ? report.key_points : []
  if (keyPoints.length > 0) {
    pushLine('Puntos clave:')
    keyPoints.forEach((item) => pushLine(`- ${item}`))
    pushLine()
  }

  const topics = Array.isArray(report.topics) ? report.topics : []
  if (topics.length > 0) {
    pushLine('Temas tratados:')
    topics.forEach((topic, idx) => {
      pushLine(`- ${topic?.title || `Tema ${idx + 1}`}`)
      if (topic?.summary) pushLine(`  ${topic.summary}`)
      if (topic?.start_time_hint) pushLine(`  Inicio aprox.: ${topic.start_time_hint}`)
    })
    pushLine()
  }

  const decisions = Array.isArray(report.decisions) ? report.decisions : []
  if (decisions.length > 0) {
    pushLine('Decisiones:')
    decisions.forEach((item) => pushLine(`- ${item}`))
    pushLine()
  }

  const actionItems = Array.isArray(report.action_items) ? report.action_items : []
  if (actionItems.length > 0) {
    pushLine('Tareas:')
    actionItems.forEach((item) => {
      const task = item?.task || 'Tarea'
      const owner = item?.owner ? ` | Responsable: ${item.owner}` : ''
      const dueDate = item?.due_date ? ` | Fecha: ${item.due_date}` : ''
      pushLine(`- ${task}${owner}${dueDate}`)
    })
    pushLine()
  }

  const risks = Array.isArray(report.risks) ? report.risks : []
  if (risks.length > 0) {
    pushLine('Riesgos:')
    risks.forEach((item) => pushLine(`- ${item}`))
    pushLine()
  }

  const openQuestions = Array.isArray(report.open_questions) ? report.open_questions : []
  if (openQuestions.length > 0) {
    pushLine('Preguntas abiertas:')
    openQuestions.forEach((item) => pushLine(`- ${item}`))
    pushLine()
  }

  return lines.join('\n').trim()
}
