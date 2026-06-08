import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'

let dir
let storePath

beforeEach(() => {
  dir = path.join(os.tmpdir(), `store-test-${randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  storePath = path.join(dir, 'store.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('createStore', () => {
  it('persists and reads back a progress record', () => {
    const store = createStore({ storePath })
    store.setProgress('k1', { status: 'running', progress_percent: 10 })

    const rec = store.getProgress('k1')
    expect(rec.status).toBe('running')
    expect(rec.progress_percent).toBe(10)
    expect(rec.key).toBe('k1')
    expect(rec.created_at).toBeTruthy()
    expect(rec.updated_at).toBeTruthy()
  })

  it('merges successive patches, keeping created_at', () => {
    const store = createStore({ storePath })
    store.setProgress('k1', { status: 'starting', stage: 'starting' })
    const created = store.getProgress('k1').created_at
    store.setProgress('k1', { status: 'running', progress_percent: 50 })

    const rec = store.getProgress('k1')
    expect(rec.status).toBe('running')
    expect(rec.stage).toBe('starting')
    expect(rec.progress_percent).toBe(50)
    expect(rec.created_at).toBe(created)
  })

  it('returns null for an unknown key', () => {
    const store = createStore({ storePath })
    expect(store.getProgress('missing')).toBeNull()
  })

  it('writes the file atomically without leaving a .tmp behind', () => {
    const store = createStore({ storePath })
    store.setProgress('k1', { status: 'done' })

    expect(fs.existsSync(storePath)).toBe(true)
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(false)
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    expect(parsed.records.k1.status).toBe('done')
  })

  it('expires in-progress records past the progress TTL', () => {
    let nowMs = 1_000_000
    const store = createStore({
      storePath,
      progressTtlMs: 1000,
      resultTtlMs: 100_000,
      now: () => nowMs,
    })
    store.setProgress('k1', { status: 'running' })

    nowMs += 1500
    expect(store.getProgress('k1')).toBeNull()
  })

  it('keeps done records under the longer result TTL', () => {
    let nowMs = 1_000_000
    const store = createStore({
      storePath,
      progressTtlMs: 1000,
      resultTtlMs: 100_000,
      now: () => nowMs,
    })
    store.setProgress('k1', { status: 'done', result: { ok: true } })

    nowMs += 5000
    const rec = store.getProgress('k1')
    expect(rec).not.toBeNull()
    expect(rec.result.ok).toBe(true)
  })

  it('reconciles interrupted jobs into an error state', () => {
    const store = createStore({ storePath })
    store.setProgress('queued', { status: 'queued' })
    store.setProgress('starting', { status: 'starting' })
    store.setProgress('running', { status: 'running' })
    store.setProgress('done', { status: 'done', result: { ok: true } })
    store.setProgress('errored', { status: 'error', error: 'boom' })

    const changed = store.reconcileInterrupted()

    expect(changed).toBe(3)
    expect(store.getProgress('queued').status).toBe('error')
    expect(store.getProgress('starting').status).toBe('error')
    expect(store.getProgress('running').status).toBe('error')
    expect(store.getProgress('running').error).toBeTruthy()
    expect(store.getProgress('done').status).toBe('done')
    expect(store.getProgress('errored').error).toBe('boom')
  })

  it('loads existing records from disk on construction', () => {
    const first = createStore({ storePath })
    first.setProgress('k1', { status: 'done', result: { value: 42 } })

    const second = createStore({ storePath })
    expect(second.getProgress('k1').result.value).toBe(42)
  })

  it('tolerates a corrupt store file by starting empty', () => {
    fs.writeFileSync(storePath, '{ this is not json', 'utf8')
    const store = createStore({ storePath })
    expect(store.getProgress('anything')).toBeNull()
    store.setProgress('k1', { status: 'running' })
    expect(store.getProgress('k1').status).toBe('running')
  })
})
