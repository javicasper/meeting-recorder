import fs from 'node:fs'

const DEFAULT_PROGRESS_TTL_MS = 3600000 // 1h
const DEFAULT_RESULT_TTL_MS = 604800000 // 7d
const INTERRUPTED_STATUSES = ['queued', 'starting', 'running']

const loadRecords = (storePath) => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') {
      return parsed.records
    }
  } catch {
    // Missing or corrupt store: start empty.
  }
  return {}
}

/**
 * File-backed transcription progress store.
 * Writes are atomic (temp file + rename) to avoid corruption on crash, and
 * stale records are evicted lazily on read based on their TTL.
 */
export const createStore = ({
  storePath,
  progressTtlMs = DEFAULT_PROGRESS_TTL_MS,
  resultTtlMs = DEFAULT_RESULT_TTL_MS,
  now = () => Date.now(),
} = {}) => {
  const records = loadRecords(storePath)

  const persist = () => {
    const tmpPath = `${storePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify({ records }, null, 2), 'utf8')
    fs.renameSync(tmpPath, storePath)
  }

  const isoNow = () => new Date(now()).toISOString()

  const setProgress = (key, patch = {}) => {
    if (!key) return
    const current = records[key] || { key, created_at: isoNow() }
    records[key] = {
      ...current,
      ...patch,
      key,
      updated_at: isoNow(),
    }
    persist()
  }

  const getProgress = (key) => {
    const item = records[key]
    if (!item) return null

    const updatedMs = new Date(item.updated_at || item.created_at).getTime()
    const ttl =
      item.status === 'done' || item.status === 'error' ? resultTtlMs : progressTtlMs
    if (now() - updatedMs > ttl) {
      delete records[key]
      persist()
      return null
    }
    return item
  }

  const reconcileInterrupted = () => {
    let changed = 0
    for (const [key, rec] of Object.entries(records)) {
      if (INTERRUPTED_STATUSES.includes(rec.status)) {
        records[key] = {
          ...rec,
          status: 'error',
          stage: 'error',
          stage_label: 'Interrumpido por reinicio del servidor.',
          error: 'interrupted_by_restart',
          updated_at: isoNow(),
        }
        changed += 1
      }
    }
    if (changed > 0) persist()
    return changed
  }

  return { setProgress, getProgress, reconcileInterrupted, persist }
}
