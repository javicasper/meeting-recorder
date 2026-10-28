import fs from 'node:fs'
import express from 'express'
import OpenAI from 'openai'
import { sonioxCostUsd, tokensToTurns, turnsToText } from '../src/lib/turns.js'

const PORT = Number(process.env.API_PORT || '8787')
const SONIOX_API_KEY = process.env.SONIOX_API_KEY
const SONIOX = 'https://api.soniox.com/v1'
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'gpt-6-luna'
const MAX_UPLOAD = process.env.MAX_UPLOAD || '2gb'
// USD per 1M tokens; defaults are gpt-6-luna list prices.
const SUMMARY_PRICE_IN = Number(process.env.SUMMARY_PRICE_IN || '0.10')
const SUMMARY_PRICE_OUT = Number(process.env.SUMMARY_PRICE_OUT || '0.50')

if (!SONIOX_API_KEY || !process.env.OPENAI_API_KEY) {
  console.error('Faltan SONIOX_API_KEY u OPENAI_API_KEY en el entorno.')
  process.exit(1)
}

const openai = new OpenAI()

const terms = fs
  .readFileSync(new URL('./vocabulary.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))

// Shared by live (browser WebSocket) and file transcription so both behave the same.
const sttConfig = {
  language_hints: ['es'],
  enable_speaker_diarization: true,
  context: {
    text: 'Reunión interna de trabajo del equipo de Traventia, agencia de viajes online española.',
    terms,
  },
}

const soniox = async (path, init = {}) => {
  const response = await fetch(`${SONIOX}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SONIOX_API_KEY}`, ...init.headers },
  })
  if (!response.ok) {
    throw new Error(`Soniox ${path}: ${response.status} ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
}

const app = express()

// Short-lived key so the browser can stream to Soniox without seeing the real one.
app.post('/api/live-session', async (req, res, next) => {
  try {
    const { api_key } = await soniox('/auth/temporary-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 300,
        max_session_duration_seconds: 18000,
        // Tags the usage log so the real cost can be looked up per recording.
        client_reference_id: String(req.query.ref || ''),
      }),
    })
    res.json({ api_key, config: { model: 'stt-rt-v5', audio_format: 'auto', ...sttConfig } })
  } catch (error) {
    next(error)
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const transcribeFile = async (buffer, fileName, referenceId) => {
  let fileId = ''
  let transcriptionId = ''
  try {
    const form = new FormData()
    form.append('file', new Blob([buffer]), fileName)
    fileId = (await soniox('/files', { method: 'POST', body: form })).id

    transcriptionId = (
      await soniox('/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'stt-async-v5',
          file_id: fileId,
          client_reference_id: referenceId,
          ...sttConfig,
        }),
      })
    ).id

    let job
    for (;;) {
      job = await soniox(`/transcriptions/${transcriptionId}`)
      if (job.status === 'completed') break
      if (job.status === 'error') throw new Error(job.error_message || 'Soniox error')
      await sleep(2000)
    }

    const { tokens } = await soniox(`/transcriptions/${transcriptionId}/transcript`)
    return {
      speaker_turns: tokensToTurns(tokens),
      transcription_model: 'soniox stt-async-v5',
      transcription_cost_usd: sonioxCostUsd({
        audioSeconds: job.audio_duration_ms / 1000,
        outputTokens: tokens.length,
      }),
    }
  } finally {
    // Don't leave meeting audio stored at the provider.
    if (transcriptionId) soniox(`/transcriptions/${transcriptionId}`, { method: 'DELETE' }).catch(() => {})
    if (fileId) soniox(`/files/${fileId}`, { method: 'DELETE' }).catch(() => {})
  }
}

// Jobs by recording id, so a page reload can pick the result up again.
// ponytail: in memory, lost if the API restarts; persist to disk if that ever matters.
const jobs = new Map()
const JOB_TTL_MS = 60 * 60 * 1000

// Whole recording in one request: Soniox takes webm/opus as-is, no ffmpeg or chunking.
app.post(
  '/api/transcriptions/:id',
  express.raw({ type: () => true, limit: MAX_UPLOAD }),
  (req, res) => {
    const { id } = req.params
    if (jobs.get(id)?.status === 'running') return res.status(202).json(jobs.get(id))

    const job = { status: 'running', started_at: new Date().toISOString() }
    jobs.set(id, job)
    transcribeFile(req.body, req.get('x-file-name') || 'recording.webm', id)
      .then((result) => Object.assign(job, { status: 'done', result }))
      .catch((error) => {
        console.error(error)
        Object.assign(job, { status: 'error', detail: error.message })
      })
      .finally(() => setTimeout(() => jobs.delete(id), JOB_TTL_MS))
    res.status(202).json(job)
  }
)

// The browser acks once it has stored the result.
app.delete('/api/transcriptions/:id', (req, res) => {
  jobs.delete(req.params.id)
  res.status(204).end()
})

app.get('/api/transcriptions/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ detail: 'No hay transcripción en curso.' })
  res.json(job)
})

// Real Soniox cost for a recording, from its usage logs (they show up a few seconds
// after the request ends; 404 until then).
app.get('/api/costs/:id', async (req, res, next) => {
  try {
    const since = new Date(req.query.since || Date.now() - 6 * 3600 * 1000)
    const params = new URLSearchParams({
      start_time: new Date(since.getTime() - 5 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + 60 * 1000).toISOString(),
    })
    // ponytail: first page only; fine while traffic is a handful of meetings a day.
    const { usage_logs: logs } = await soniox(`/usage-logs?${params}`)
    const mine = logs.filter((log) => log.client_reference_id === req.params.id)
    if (mine.length === 0) return res.status(404).json({ detail: 'Sin registro de uso todavía.' })
    res.json({ cost_usd: mine.reduce((sum, log) => sum + Number(log.cost_usd), 0) })
  } catch (error) {
    next(error)
  }
})

const stringList = { type: 'array', items: { type: 'string' } }
const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'meeting_title',
    'summary',
    'participants',
    'key_points',
    'topics',
    'decisions',
    'action_items',
    'risks',
    'open_questions',
  ],
  properties: {
    meeting_title: { type: 'string' },
    summary: { type: 'string' },
    participants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker', 'name', 'role'],
        properties: {
          speaker: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
    key_points: stringList,
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'start_time_hint'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          start_time_hint: { type: 'string' },
        },
      },
    },
    decisions: stringList,
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'owner', 'due_date'],
        properties: {
          task: { type: 'string' },
          owner: { type: 'string' },
          due_date: { type: 'string' },
        },
      },
    },
    risks: stringList,
    open_questions: stringList,
  },
}

const REPORT_PROMPT = `Eres quien levanta acta de reuniones internas de Traventia (agencia de viajes online; equipo de tecnología, producto y operaciones).
Recibes la transcripción completa con marcas de tiempo y hablantes anónimos ("Hablante 1", "Hablante 2"...). Escribe en español.

- meeting_title: título concreto (máx. 80 caracteres), no genérico.
- summary: 1-2 párrafos: de qué iba, a qué se llegó y qué queda pendiente.
- participants: uno por hablante. "name" solo si se deduce de la conversación (alguien le llama por su nombre, se presenta…); si no, cadena vacía. "role": qué papel juega en la reunión.
- key_points: lo importante que alguien que no estuvo debe saber.
- topics: temas en orden, con start_time_hint como "mm:ss" de la transcripción.
- decisions: solo lo que se decidió de verdad, no ideas sueltas.
- action_items: tareas concretas; owner = nombre (o "Hablante N") si se asignó, si no cadena vacía; due_date solo si se dijo.
- risks y open_questions: lo que quedó en el aire.
No inventes nada que no esté en la transcripción. Listas vacías si no hay contenido.`

app.post('/api/reports', express.json({ limit: '20mb' }), async (req, res, next) => {
  try {
    const transcript = turnsToText(req.body.speaker_turns || [])
    if (!transcript.trim()) return res.status(400).json({ detail: 'Transcripción vacía.' })

    const completion = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: REPORT_PROMPT },
        { role: 'user', content: transcript },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'meeting_report', strict: true, schema: reportSchema },
      },
    })
    const { prompt_tokens, completion_tokens } = completion.usage
    res.json({
      report: JSON.parse(completion.choices[0].message.content),
      report_model: SUMMARY_MODEL,
      report_cost_usd:
        (prompt_tokens * SUMMARY_PRICE_IN + completion_tokens * SUMMARY_PRICE_OUT) / 1e6,
    })
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(500).json({ detail: error.message })
})

app.listen(PORT, () => console.log(`API on http://localhost:${PORT} (summary: ${SUMMARY_MODEL})`))
