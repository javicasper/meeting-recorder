#!/usr/bin/env node
// Stdio MCP server exposing recorded meetings (read-only) to Claude Code.
// ponytail: hand-rolled JSON-RPC instead of @modelcontextprotocol/sdk; three tools don't need a dependency.
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'

const db = new DatabaseSync(new URL('../data/meetings.db', import.meta.url).pathname, { readOnly: true })

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const line = (t) => `[${mmss(t.start)}] ${t.speaker ? t.speaker + ": " : ""}${t.text.trim()}`
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function rows() {
  // ponytail: loads every row per call; fine for hundreds of meetings, add FTS5 if it grows to thousands.
  return db.prepare('SELECT id, created_at, meta, transcription FROM recordings ORDER BY created_at DESC').all().map((r) => {
    const meta = JSON.parse(r.meta)
    const t = r.transcription ? JSON.parse(r.transcription) : null
    return {
      id: r.id,
      date: r.created_at,
      title: meta.displayTitle || meta.name,
      durationMin: meta.durationSeconds ? Math.round(meta.durationSeconds / 60) : null,
      transcribed: !!t,
      turns: t?.speaker_turns ?? [],
      text: t?.transcript_text ?? '',
      report: t?.report ?? null,
    }
  })
}

const summary = ({ id, date, title, durationMin, transcribed }) => ({ id, date, title, durationMin, transcribed })

const tools = {
  list_meetings: {
    description: 'List recorded meetings (newest first). Optional title filter and date range (ISO dates).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Substring of the meeting title (accent/case-insensitive)' },
        from: { type: 'string', description: 'ISO date, inclusive' },
        to: { type: 'string', description: 'ISO date, inclusive' },
        limit: { type: 'number', default: 50 },
      },
    },
    run: ({ title, from, to, limit = 50 }) =>
      rows()
        .filter((m) => !title || fold(m.title).includes(fold(title)))
        .filter((m) => !from || m.date >= from)
        .filter((m) => !to || m.date.slice(0, 10) <= to.slice(0, 10))
        .slice(0, limit)
        .map(summary),
  },
  search_meetings: {
    description: 'Full-text search across meeting titles, reports and transcripts. Returns matching meetings with timestamped snippets.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number', default: 10 } },
      required: ['query'],
    },
    run: ({ query, limit = 10 }) => {
      const words = fold(query).split(/\s+/).filter(Boolean)
      const hit = (s) => words.some((w) => fold(s).includes(w))
      return rows()
        .map((m) => ({
          m,
          snippets: m.turns.filter((t) => hit(t.text)).map(line),
          titleHit: hit(m.title) || (m.report && hit(JSON.stringify(m.report))),
        }))
        .filter((x) => x.snippets.length || x.titleHit)
        .sort((a, b) => b.snippets.length - a.snippets.length)
        .slice(0, limit)
        .map(({ m, snippets }) => ({ ...summary(m), matches: snippets.length, snippets: snippets.slice(0, 8) }))
    },
  },
  get_meeting: {
    description: 'Full meeting: report/summary and timestamped transcript (mm:ss, speaker).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, includeTranscript: { type: 'boolean', default: true } },
      required: ['id'],
    },
    run: ({ id, includeTranscript = true }) => {
      const m = rows().find((r) => r.id === id)
      if (!m) throw new Error(`Meeting ${id} not found`)
      return {
        ...summary(m),
        report: m.report,
        transcript: includeTranscript
          ? m.turns.length ? m.turns.map(line).join('\n') : m.text
          : undefined,
      }
    },
  },
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meetings', version: '1.0.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) }
    case 'tools/call': {
      const tool = tools[params.name]
      if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 })
      try {
        return { content: [{ type: 'text', text: JSON.stringify(tool.run(params.arguments ?? {}), null, 1) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true }
      }
    }
    default:
      if (id === undefined) return undefined // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }) }
  try {
    const result = handle(req)
    if (req.id !== undefined) send({ id: req.id, result })
  } catch (e) {
    if (req.id !== undefined) send({ id: req.id, error: { code: e.code ?? -32603, message: e.message } })
  }
})
