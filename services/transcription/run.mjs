import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'

const [, , inputFileArg] = process.argv

if (!inputFileArg) {
  console.error('Uso: node services/transcription/run.mjs <ruta-a-audio-o-video>')
  process.exit(1)
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Falta OPENAI_API_KEY en el entorno.')
  process.exit(1)
}

const inputFile = path.resolve(inputFileArg)
if (!fs.existsSync(inputFile)) {
  console.error(`No existe el archivo: ${inputFile}`)
  process.exit(1)
}

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || ''
const DASHSCOPE_BASE_URL =
  process.env.DASHSCOPE_BASE_URL || 'https://coding-intl.dashscope.aliyuncs.com/v1'
const useDashScope = !!DASHSCOPE_API_KEY

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const llmClient = useDashScope
  ? new OpenAI({ apiKey: DASHSCOPE_API_KEY, baseURL: DASHSCOPE_BASE_URL })
  : client
const reportModel = process.env.REPORT_MODEL || (useDashScope ? 'qwen3.5-plus' : 'gpt-4.1-mini')
const whisperRatePerMinute = Number(process.env.WHISPER_RATE_PER_MINUTE || '0.006')

const now = new Date()
const stamp = now.toISOString().replaceAll(':', '-')
const baseName = path.basename(inputFile, path.extname(inputFile))
const outDir = path.resolve('services/transcription/out', `${baseName}-${stamp}`)
fs.mkdirSync(outDir, { recursive: true })

const defaultModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize'
let transcription = null
let usedModel = defaultModel

try {
  transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(inputFile),
    model: defaultModel,
    response_format: 'verbose_json',
  })
} catch (error) {
  // Fallback robusto si el modelo diarize no está disponible en la cuenta/proyecto.
  usedModel = 'whisper-1'
  transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(inputFile),
    model: usedModel,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  })
}

const transcriptText = transcription.text || ''
const segments = Array.isArray(transcription.segments) ? transcription.segments : []
const words = Array.isArray(transcription.words) ? transcription.words : []
const usage = transcription.usage || null

let estimatedTranscriptionCostUsd = null
if (usage && usage.type === 'duration' && Number.isFinite(usage.seconds)) {
  estimatedTranscriptionCostUsd = (usage.seconds / 60) * whisperRatePerMinute
}

const speakerTurns = segments.map((segment, index) => ({
  index,
  start: segment.start,
  end: segment.end,
  text: segment.text,
  speaker: segment.speaker || null,
}))

const reportPrompt = `
Eres un analista de reuniones. Devuelve un JSON válido con esta estructura exacta:
{
  "summary": "resumen breve",
  "decisions": ["..."],
  "action_items": [{"task":"...", "owner":"...", "due_date":"..."}],
  "risks": ["..."],
  "open_questions": ["..."]
}
Si falta información, usa null o array vacío.
Idioma: español.
`.trim()

const reportResponse = await llmClient.chat.completions.create({
  model: reportModel,
  messages: [
    { role: 'system', content: reportPrompt },
    {
      role: 'user',
      content: `TRANSCRIPCIÓN:\n${transcriptText}\n\nTURNOS:\n${JSON.stringify(speakerTurns)}`,
    },
  ],
})

const reportText = reportResponse.choices[0].message.content || '{}'
let reportJson = null
try {
  reportJson = JSON.parse(reportText)
} catch {
  reportJson = { raw: reportText }
}

const fullOutput = {
  source_file: inputFile,
  generated_at: now.toISOString(),
  transcription_model: usedModel,
  transcription_usage: usage,
  estimated_transcription_cost_usd: estimatedTranscriptionCostUsd,
  transcript_text: transcriptText,
  speaker_turns: speakerTurns,
  words_count: words.length,
  segments_count: segments.length,
  report: reportJson,
}

fs.writeFileSync(path.join(outDir, 'transcript.txt'), transcriptText, 'utf8')
fs.writeFileSync(
  path.join(outDir, 'speaker_turns.json'),
  JSON.stringify(speakerTurns, null, 2),
  'utf8'
)
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(reportJson, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'full_output.json'), JSON.stringify(fullOutput, null, 2), 'utf8')

console.log(`OK. Resultados en: ${outDir}`)
if (estimatedTranscriptionCostUsd !== null) {
  console.log(
    `Coste transcripcion estimado (USD): ${estimatedTranscriptionCostUsd.toFixed(6)}`
  )
}
