import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import archiver from 'archiver'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import OpenAI from 'openai'

const execFileAsync = promisify(execFile)

const PORT = Number(process.env.TRANSCRIPTION_API_PORT || '8787')
const whisperRatePerMinute = Number(process.env.WHISPER_RATE_PER_MINUTE || '0.006')
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UPLOAD_BYTES = Number(
  process.env.TRANSCRIBE_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES
)
const CHUNK_SECONDS = Number(process.env.TRANSCRIBE_CHUNK_SECONDS || '480')
const SUMMARY_MODEL = 'gpt-5.4-mini'
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || '1800000')
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || '2')
const TRANSCRIBE_CHUNK_TIMEOUT_MS = Number(
  process.env.TRANSCRIBE_CHUNK_TIMEOUT_MS || '600000'
)
const SUMMARY_TIMEOUT_MS = Number(process.env.SUMMARY_TIMEOUT_MS || '600000')
const CLEAN_MAX_INPUT_CHARS = Number(process.env.CLEAN_MAX_INPUT_CHARS || '120000')
const REPORT_MAX_TRANSCRIPT_CHARS = Number(
  process.env.REPORT_MAX_TRANSCRIPT_CHARS || '80000'
)
const REPORT_MAX_SPEAKER_TURNS = Number(process.env.REPORT_MAX_SPEAKER_TURNS || '320')
const PROGRESS_TTL_MS = Number(process.env.TRANSCRIBE_PROGRESS_TTL_MS || '3600000')
const RESULT_TTL_MS = Number(process.env.TRANSCRIBE_RESULT_TTL_MS || '604800000')

if (!process.env.OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY para levantar transcription API.')
  process.exit(1)
}

const uploadRoot = path.join(os.tmpdir(), 'meeting-recorder-uploads')
fs.mkdirSync(uploadRoot, { recursive: true })
const dataRoot = path.resolve('services/transcription/data')
const storePath = path.join(dataRoot, 'transcription-store.json')
fs.mkdirSync(dataRoot, { recursive: true })

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: OPENAI_MAX_RETRIES,
})
const app = express()
const transcriptionStore = (() => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') {
      return parsed
    }
  } catch {
    // Ignore and initialize empty store.
  }
  return { records: {} }
})()

const logEvent = (event, details = {}) => {
  console.log(event, {
    at: new Date().toISOString(),
    ...details,
  })
}

const persistTranscriptionStore = () => {
  fs.writeFileSync(storePath, JSON.stringify(transcriptionStore, null, 2), 'utf8')
}

const setTranscriptionProgress = (key, patch = {}) => {
  if (!key) return
  const current = transcriptionStore.records[key] || {
    key,
    created_at: new Date().toISOString(),
  }
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  }
  transcriptionStore.records[key] = next
  persistTranscriptionStore()
}

const getTranscriptionProgress = (key) => {
  const item = transcriptionStore.records[key]
  if (!item) return null
  const updatedMs = new Date(item.updated_at || item.created_at).getTime()
  const ttl =
    item.status === 'done' || item.status === 'error' ? RESULT_TTL_MS : PROGRESS_TTL_MS
  if (Date.now() - updatedMs > ttl) {
    delete transcriptionStore.records[key]
    persistTranscriptionStore()
    return null
  }
  return item
}

const clipTextMiddle = (text, maxChars) => {
  const value = String(text || '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (value.length <= maxChars) return value

  const keep = Math.max(1, Math.floor((maxChars - 40) / 2))
  return `${value.slice(0, keep)}\n\n[... recortado ...]\n\n${value.slice(-keep)}`
}

const downsampleSpeakerTurns = (speakerTurns, maxTurns) => {
  if (!Array.isArray(speakerTurns)) return []
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) return []
  if (speakerTurns.length <= maxTurns) return speakerTurns

  const sampled = []
  const lastIndex = speakerTurns.length - 1
  for (let i = 0; i < maxTurns; i += 1) {
    const index = Math.round((i * lastIndex) / (maxTurns - 1))
    sampled.push(speakerTurns[index])
  }
  return sampled
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, `${Date.now()}-${randomUUID()}-${safeName}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, max_upload_bytes: MAX_UPLOAD_BYTES })
})

app.get('/api/transcriptions/progress/:key', (req, res) => {
  const key = String(req.params?.key || '').trim()
  if (!key) {
    res.status(400).json({ error: 'Falta key de progreso.' })
    return
  }

  const progress = getTranscriptionProgress(key)
  if (!progress) {
    res.status(404).json({ error: 'No hay progreso para esa key.' })
    return
  }

  res.json(progress)
})

app.get('/api/transcriptions/by-key/:key', (req, res) => {
  const key = String(req.params?.key || '').trim()
  if (!key) {
    res.status(400).json({ error: 'Falta key de transcripción.' })
    return
  }

  const record = getTranscriptionProgress(key)
  if (!record) {
    res.status(404).json({ error: 'No hay transcripción para esa key.' })
    return
  }

  res.json(record)
})

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** power
  return `${value.toFixed(power === 0 ? 0 : 1)} ${units[power]}`
}

const probeDurationSeconds = async (filePath) => {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      filePath,
    ])
    const parsed = Number(stdout.trim())
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

const splitIntoAudioChunks = async (inputPath, chunksDir) => {
  fs.mkdirSync(chunksDir, { recursive: true })

  const pattern = path.join(chunksDir, 'chunk-%03d.mp3')
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'segment',
    '-segment_time',
    String(CHUNK_SECONDS),
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    pattern,
  ])

  const files = fs
    .readdirSync(chunksDir)
    .filter((name) => name.endsWith('.mp3'))
    .sort()
    .map((name) => path.join(chunksDir, name))

  if (files.length === 0) {
    throw new Error('No se generaron chunks de audio a partir del archivo.')
  }

  let accumulatedStart = 0
  const chunks = []
  for (let index = 0; index < files.length; index += 1) {
    const chunkPath = files[index]
    const duration = await probeDurationSeconds(chunkPath)

    chunks.push({
      index,
      path: chunkPath,
      start: accumulatedStart,
      duration,
    })

    accumulatedStart += duration
  }

  return chunks
}

const sanitizeFileName = (value, fallback = 'reunion') => {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')

  return normalized || fallback
}

const transcribeChunk = async (chunkPath, preferredModel, context = {}) => {
  const fileName = path.basename(chunkPath)
  const data = await fs.promises.readFile(chunkPath)
  const uploadFile = new File([data], fileName, { type: 'audio/mpeg' })
  const startedAt = Date.now()
  const {
    requestId = 'n/a',
    chunkIndex = -1,
    totalChunks = 0,
    chunkStartSeconds = 0,
    chunkDurationSeconds = 0,
  } = context

  logEvent('chunk_transcription_start', {
    request_id: requestId,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
    chunk_start_seconds: chunkStartSeconds,
    chunk_duration_seconds: chunkDurationSeconds,
    file_name: fileName,
    preferred_model: preferredModel,
    chunk_bytes: data.length,
  })

  try {
    const transcription = await client.audio.transcriptions.create({
      file: uploadFile,
      model: preferredModel,
      language: 'es',
      prompt:
        'Transcripción de una reunión en español. Mantén nombres y términos tal cual, sin resumir.',
      response_format: 'verbose_json',
    }, {
      timeout: TRANSCRIBE_CHUNK_TIMEOUT_MS,
    })

    logEvent('chunk_transcription_ok', {
      request_id: requestId,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      model: preferredModel,
      elapsed_ms: Date.now() - startedAt,
      text_length: (transcription.text || '').length,
      segments_count: Array.isArray(transcription.segments)
        ? transcription.segments.length
        : 0,
    })

    return { model: preferredModel, transcription, preferredUnsupported: false }
  } catch (error) {
    logEvent('chunk_transcription_primary_failed', {
      request_id: requestId,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      preferred_model: preferredModel,
      elapsed_ms: Date.now() - startedAt,
      error_message: error instanceof Error ? error.message : 'unknown_error',
      status: error?.status,
      code: error?.code,
      type: error?.type,
    })

    const fallbackModel = 'whisper-1'
    const transcription = await client.audio.transcriptions.create({
      file: uploadFile,
      model: fallbackModel,
      language: 'es',
      prompt:
        'Transcripción de una reunión en español. Mantén nombres y términos tal cual, sin resumir.',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    }, {
      timeout: TRANSCRIBE_CHUNK_TIMEOUT_MS,
    })

    logEvent('chunk_transcription_fallback_ok', {
      request_id: requestId,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      model: fallbackModel,
      elapsed_ms: Date.now() - startedAt,
      text_length: (transcription.text || '').length,
      segments_count: Array.isArray(transcription.segments)
        ? transcription.segments.length
        : 0,
    })

    return {
      model: fallbackModel,
      transcription,
      preferredUnsupported: error?.code === 'unsupported_value',
    }
  }
}

const cleanTranscript = async (rawTranscript, requestId = 'n/a') => {
  if (!rawTranscript?.trim()) return rawTranscript
  const cleanInput = clipTextMiddle(rawTranscript, CLEAN_MAX_INPUT_CHARS)
  const startedAt = Date.now()
  logEvent('clean_transcript_start', {
    request_id: requestId,
    input_chars: rawTranscript.length,
    clipped_input_chars: cleanInput.length,
  })

  const response = await client.responses.create({
    model: SUMMARY_MODEL,
    input: [
      {
        role: 'system',
        content:
          'Eres editor de transcripciones. Corrige puntuación y frases rotas sin inventar contenido. Devuelve solo texto plano en español.',
      },
      {
        role: 'user',
        content: `Limpia esta transcripción sin añadir información:\n\n${cleanInput}`,
      },
    ],
  }, {
    timeout: SUMMARY_TIMEOUT_MS,
  })

  logEvent('clean_transcript_done', {
    request_id: requestId,
    elapsed_ms: Date.now() - startedAt,
    output_chars: (response.output_text || '').length,
  })

  return response.output_text?.trim() || rawTranscript
}

const buildReport = async (
  transcriptText,
  speakerTurns,
  requestId = 'n/a',
  options = {}
) => {
  const maxTranscriptChars = Number(
    options.maxTranscriptChars || REPORT_MAX_TRANSCRIPT_CHARS
  )
  const maxSpeakerTurns = Number(
    options.maxSpeakerTurns || REPORT_MAX_SPEAKER_TURNS
  )
  const reportTranscript = clipTextMiddle(transcriptText, maxTranscriptChars)
  const reportTurns = downsampleSpeakerTurns(speakerTurns, maxSpeakerTurns)
  const startedAt = Date.now()
  logEvent('build_report_start', {
    request_id: requestId,
    transcript_chars: transcriptText.length,
    report_transcript_chars: reportTranscript.length,
    speaker_turns: Array.isArray(speakerTurns) ? speakerTurns.length : 0,
    report_speaker_turns: reportTurns.length,
  })

  const reportPrompt = `
Eres un analista senior de reuniones. Devuelve JSON válido con esta estructura exacta:
{
  "meeting_title": "título corto y claro de la reunión (max 80 caracteres)",
  "summary": "resumen ejecutivo extenso (8-12 líneas)",
  "key_points": ["..."],
  "topics": [{"title":"...", "summary":"...", "start_time_hint":"..."}],
  "decisions": ["..."],
  "action_items": [{"task":"...", "owner":"...", "due_date":"..."}],
  "risks": ["..."],
  "open_questions": ["..."]
}
Reglas:
- No inventes datos.
- Si falta información, usa null o [].
- Escribe en español claro y estructurado.
`.trim()

  const reportResponse = await client.responses.create({
    model: SUMMARY_MODEL,
    input: [
      { role: 'system', content: reportPrompt },
      {
        role: 'user',
        content: `TRANSCRIPCIÓN:\n${reportTranscript}\n\nTURNOS:\n${JSON.stringify(reportTurns)}`,
      },
    ],
  }, {
    timeout: SUMMARY_TIMEOUT_MS,
  })

  logEvent('build_report_done', {
    request_id: requestId,
    elapsed_ms: Date.now() - startedAt,
    output_chars: (reportResponse.output_text || '').length,
  })

  const reportText = reportResponse.output_text || '{}'
  try {
    return JSON.parse(reportText)
  } catch {
    return { raw: reportText }
  }
}

const normalizeReport = (report) => {
  if (!report || typeof report !== 'object') {
    return {
      meeting_title: '',
      summary: '',
      key_points: [],
      topics: [],
      decisions: [],
      action_items: [],
      risks: [],
      open_questions: [],
    }
  }

  return {
    meeting_title:
      typeof report.meeting_title === 'string' ? report.meeting_title : '',
    summary: typeof report.summary === 'string' ? report.summary : '',
    key_points: Array.isArray(report.key_points) ? report.key_points : [],
    topics: Array.isArray(report.topics) ? report.topics : [],
    decisions: Array.isArray(report.decisions) ? report.decisions : [],
    action_items: Array.isArray(report.action_items) ? report.action_items : [],
    risks: Array.isArray(report.risks) ? report.risks : [],
    open_questions: Array.isArray(report.open_questions)
      ? report.open_questions
      : [],
  }
}

app.post('/api/transcriptions', upload.single('file'), async (req, res) => {
  const requestId = randomUUID()
  const requestStartedAt = Date.now()
  const file = req.file
  const progressKeyRaw = String(req.body?.transcription_key || '').trim()
  const progressKey = progressKeyRaw || requestId
  let chunksDir = ''

  req.on('aborted', () => {
    logEvent('transcription_request_aborted_by_client', {
      request_id: requestId,
    })
  })

  try {
    const existing = getTranscriptionProgress(progressKey)
    if (existing?.status === 'done' && existing?.result) {
      logEvent('transcription_request_cache_hit', {
        request_id: requestId,
        progress_key: progressKey,
      })
      res.json(existing.result)
      return
    }
    if (existing?.status === 'running' || existing?.status === 'starting') {
      res.status(409).json({
        error: 'Ya hay una transcripción en curso para esta key.',
        status: existing.status,
        progress_key: progressKey,
      })
      return
    }

    if (!file) {
      res.status(400).json({ error: 'Falta archivo en campo "file".' })
      return
    }

    setTranscriptionProgress(progressKey, {
      request_id: requestId,
      status: 'starting',
      stage: 'starting',
      stage_label: 'Iniciando transcripción...',
      progress_percent: 2,
      started_at: new Date().toISOString(),
      file_name: file.originalname,
      file_size_bytes: file.size,
      chunk_count: 0,
      processed_chunks: 0,
      error: null,
    })

    logEvent('transcription_request_start', {
      request_id: requestId,
      progress_key: progressKey,
      file_name: file.originalname,
      uploaded_path: file.path,
      file_size_bytes: file.size,
      chunk_seconds: CHUNK_SECONDS,
      openai_timeout_ms: OPENAI_TIMEOUT_MS,
      transcribe_chunk_timeout_ms: TRANSCRIBE_CHUNK_TIMEOUT_MS,
      summary_timeout_ms: SUMMARY_TIMEOUT_MS,
    })

    chunksDir = path.join(os.tmpdir(), `meeting-recorder-chunks-${randomUUID()}`)
    const splitStartedAt = Date.now()
    setTranscriptionProgress(progressKey, {
      status: 'running',
      stage: 'splitting',
      stage_label: 'Separando audio en bloques...',
      progress_percent: 8,
    })
    const chunks = await splitIntoAudioChunks(file.path, chunksDir)
    setTranscriptionProgress(progressKey, {
      status: 'running',
      stage: 'transcribing',
      stage_label: `Transcribiendo audio (0/${chunks.length})...`,
      progress_percent: 12,
      chunk_count: chunks.length,
      processed_chunks: 0,
    })
    logEvent('transcription_split_done', {
      request_id: requestId,
      elapsed_ms: Date.now() - splitStartedAt,
      chunk_count: chunks.length,
    })

    let preferredModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize'

    const transcriptParts = []
    const speakerTurns = []
    const modelsUsed = new Set()
    let usageSeconds = 0

    for (const chunk of chunks) {
      const { model, transcription, preferredUnsupported } = await transcribeChunk(
        chunk.path,
        preferredModel,
        {
        requestId,
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
        chunkStartSeconds: chunk.start,
        chunkDurationSeconds: chunk.duration,
      }
      )
      modelsUsed.add(model)

      if (preferredUnsupported && preferredModel !== 'whisper-1') {
        preferredModel = 'whisper-1'
        logEvent('transcription_preferred_model_downgraded', {
          request_id: requestId,
          new_preferred_model: preferredModel,
          reason: 'unsupported_value',
        })
      }

      const text = (transcription.text || '').trim()
      if (text) {
        transcriptParts.push(text)
      }

      if (
        transcription.usage &&
        transcription.usage.type === 'duration' &&
        Number.isFinite(transcription.usage.seconds)
      ) {
        usageSeconds += transcription.usage.seconds
      }

      const segments = Array.isArray(transcription.segments) ? transcription.segments : []
      segments.forEach((segment) => {
        speakerTurns.push({
          start: (segment.start || 0) + chunk.start,
          end: (segment.end || 0) + chunk.start,
          text: segment.text || '',
          speaker: segment.speaker || null,
          chunk_index: chunk.index,
        })
      })

      logEvent('transcription_chunk_progress', {
        request_id: requestId,
        processed_chunks: chunk.index + 1,
        total_chunks: chunks.length,
        collected_turns: speakerTurns.length,
        transcript_chars_raw: transcriptParts.join('\n').length,
      })

      const chunkProgress = 12 + ((chunk.index + 1) / chunks.length) * 72
      setTranscriptionProgress(progressKey, {
        status: 'running',
        stage: 'transcribing',
        stage_label: `Transcribiendo audio (${chunk.index + 1}/${chunks.length})...`,
        progress_percent: Math.round(chunkProgress),
        processed_chunks: chunk.index + 1,
        chunk_count: chunks.length,
      })
    }

    const transcriptTextRaw = transcriptParts.join('\n').trim()
    let transcriptText = transcriptTextRaw
    try {
      setTranscriptionProgress(progressKey, {
        status: 'running',
        stage: 'cleaning',
        stage_label: 'Limpiando transcripción...',
        progress_percent: 88,
      })
      transcriptText = await cleanTranscript(transcriptTextRaw, requestId)
    } catch (cleanError) {
      logEvent('clean_transcript_failed_fallback_raw', {
        request_id: requestId,
        message:
          cleanError instanceof Error ? cleanError.message : 'unknown_clean_error',
        status: cleanError?.status,
        code: cleanError?.code,
        type: cleanError?.type,
      })
    }

    let report = null
    try {
      setTranscriptionProgress(progressKey, {
        status: 'running',
        stage: 'reporting',
        stage_label: 'Generando resumen y acciones...',
        progress_percent: 93,
      })
      report = normalizeReport(await buildReport(transcriptText, speakerTurns, requestId))
    } catch (reportError) {
      logEvent('build_report_first_attempt_failed', {
        request_id: requestId,
        message:
          reportError instanceof Error ? reportError.message : 'unknown_report_error',
        status: reportError?.status,
        code: reportError?.code,
        type: reportError?.type,
      })

      try {
        report = normalizeReport(
          await buildReport(transcriptText, speakerTurns, requestId, {
            maxTranscriptChars: 40000,
            maxSpeakerTurns: 160,
          })
        )
        logEvent('build_report_retry_compact_ok', {
          request_id: requestId,
        })
      } catch (reportRetryError) {
        logEvent('build_report_retry_compact_failed', {
          request_id: requestId,
          message:
            reportRetryError instanceof Error
              ? reportRetryError.message
              : 'unknown_report_retry_error',
          status: reportRetryError?.status,
          code: reportRetryError?.code,
          type: reportRetryError?.type,
        })

        report = normalizeReport({
          meeting_title: 'Resumen no disponible por límite de tokens',
          summary:
            'La transcripción se completó, pero el reporte automático no se pudo generar por límites de tokens. Reintenta regenerar el resumen.',
          key_points: [],
          topics: [],
          decisions: [],
          action_items: [],
          risks: [],
          open_questions: [],
        })
      }
    }

    const estimatedTranscriptionCostUsd = (usageSeconds / 60) * whisperRatePerMinute
    setTranscriptionProgress(progressKey, {
      status: 'done',
      stage: 'done',
      stage_label: 'Transcripción completada.',
      progress_percent: 100,
      processed_chunks: chunks.length,
      chunk_count: chunks.length,
      error: null,
    })
    logEvent('transcription_request_done', {
      request_id: requestId,
      elapsed_ms: Date.now() - requestStartedAt,
      chunk_count: chunks.length,
      models_used: Array.from(modelsUsed),
      usage_seconds: usageSeconds,
      transcript_chars_raw: transcriptTextRaw.length,
      transcript_chars_clean: transcriptText.length,
      speaker_turns: speakerTurns.length,
    })

    const responsePayload = {
      transcription_model: Array.from(modelsUsed).join(', '),
      chunk_count: chunks.length,
      transcription_usage: { type: 'duration', seconds: usageSeconds },
      estimated_transcription_cost_usd: estimatedTranscriptionCostUsd,
      transcript_text_raw: transcriptTextRaw,
      transcript_text: transcriptText,
      speaker_turns: speakerTurns,
      report,
    }

    setTranscriptionProgress(progressKey, {
      result: responsePayload,
      finished_at: new Date().toISOString(),
    })

    res.json(responsePayload)
  } catch (error) {
    setTranscriptionProgress(progressKey, {
      status: 'error',
      stage: 'error',
      stage_label: 'Falló la transcripción.',
      error: error instanceof Error ? error.message : 'unknown_error',
      finished_at: new Date().toISOString(),
    })

    console.error('transcription_error', {
      request_id: requestId,
      progress_key: progressKey,
      message: error instanceof Error ? error.message : 'unknown_error',
      stack: error instanceof Error ? error.stack : undefined,
      status: error?.status,
      code: error?.code,
      type: error?.type,
    })

    res.status(500).json({
      error: 'No se pudo transcribir el archivo.',
      detail: error instanceof Error ? error.message : 'unknown_error',
    })
  } finally {
    if (file?.path) {
      fs.promises.unlink(file.path).catch(() => {})
    }
    if (chunksDir) {
      fs.promises.rm(chunksDir, { recursive: true, force: true }).catch(() => {})
    }
    logEvent('transcription_request_finally', {
      request_id: requestId,
      elapsed_ms: Date.now() - requestStartedAt,
      cleaned_upload_path: file?.path || null,
      cleaned_chunks_dir: chunksDir || null,
    })
  }
})

app.post('/api/exports/meeting-zip', async (req, res) => {
  try {
    const transcriptText = String(req.body?.transcript_text || '').trim()
    const summaryText = String(req.body?.summary_text || '').trim()
    const meetingTitle = String(req.body?.meeting_title || '').trim()

    const safeTitle = sanitizeFileName(meetingTitle, 'reunion')
    const zipName = `${safeTitle}-paquete.zip`

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`)

    const archive = archiver('zip', { zlib: { level: 9 } })

    archive.on('error', (archiveError) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'No se pudo generar el ZIP.',
          detail: archiveError instanceof Error ? archiveError.message : 'zip_error',
        })
      } else {
        res.destroy(archiveError)
      }
    })

    archive.pipe(res)
    archive.append(`${transcriptText || 'Sin transcripción.'}\n`, {
      name: 'transcripcion.txt',
    })
    archive.append(`${summaryText || 'Sin resumen.'}\n`, { name: 'resumen.txt' })
    await archive.finalize()
  } catch (error) {
    console.error('meeting_export_error', {
      message: error instanceof Error ? error.message : 'unknown_error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    if (!res.headersSent) {
      res.status(500).json({
        error: 'No se pudo preparar la descarga.',
        detail: error instanceof Error ? error.message : 'unknown_error',
      })
    }
  }
})

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    const humanMax = formatBytes(MAX_UPLOAD_BYTES)
    res.status(413).json({
      error: 'Archivo demasiado grande para procesar.',
      detail: `Maximo permitido: ${humanMax} (${MAX_UPLOAD_BYTES} bytes).`,
      max_bytes: MAX_UPLOAD_BYTES,
      max_human: humanMax,
    })
    return
  }

  res.status(500).json({
    error: 'Error interno inesperado en transcripcion.',
    detail: error instanceof Error ? error.message : 'unknown_error',
  })
})

app.post('/api/reports/regenerate', async (req, res) => {
  try {
    const transcriptText = (req.body?.transcript_text || '').trim()
    const speakerTurns = Array.isArray(req.body?.speaker_turns)
      ? req.body.speaker_turns
      : []

    if (!transcriptText) {
      res.status(400).json({
        error: 'Falta transcript_text para rehacer el resumen.',
      })
      return
    }

    const report = normalizeReport(
      await buildReport(transcriptText, speakerTurns, `report-regenerate-${randomUUID()}`)
    )
    res.json({
      report_model: SUMMARY_MODEL,
      report,
    })
  } catch (error) {
    console.error('report_regenerate_error', {
      message: error instanceof Error ? error.message : 'unknown_error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    res.status(500).json({
      error: 'No se pudo rehacer el resumen.',
      detail: error instanceof Error ? error.message : 'unknown_error',
    })
  }
})

app.listen(PORT, () => {
  console.log(`Transcription API listening on http://localhost:${PORT}`)
})
