// One-shot: uploads recordings that still live in a browser's old IndexedDB storage
// ("meeting-recorder-db") to the API. Paste into the DevTools console of the origin that
// holds them (e.g. http://localhost:5173). Idempotent: skips ids the server already has.
// The local IndexedDB copy is left untouched as a backup.
;(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('meeting-recorder-db')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const readAll = (name) =>
    new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(name)) return resolve([])
      const req = db.transaction(name, 'readonly').objectStore(name).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const ok = async (response) => {
    if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`)
  }

  const recordings = await readAll('recordings')
  const transcriptions = await readAll('transcriptions')
  db.close()
  const onServer = new Set((await (await fetch('/api/recordings')).json()).map((r) => r.id))
  const transcriptionById = new Map(transcriptions.map((t) => [t.recordingId, t]))
  const result = { local: recordings.length, uploaded: 0, skipped: 0, failed: [] }

  for (const recording of recordings) {
    const { blob, url: _url, ...meta } = recording
    if (onServer.has(meta.id) || !blob) {
      result.skipped += 1
      continue
    }
    try {
      const mediaKind = meta.mediaKind || (blob.type.startsWith('audio/') ? 'audio' : 'video')
      const header = encodeURIComponent(JSON.stringify({ ...meta, mediaKind, mimeType: blob.type }))
      await ok(
        await fetch(`/api/recordings/${meta.id}`, {
          method: 'PUT',
          headers: { 'x-recording': header },
          body: blob,
        })
      )
      const transcription = transcriptionById.get(meta.id)
      if (transcription) {
        await ok(
          await fetch(`/api/recordings/${meta.id}/transcription`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(transcription),
          })
        )
      }
      result.uploaded += 1
    } catch (error) {
      result.failed.push({ id: meta.id, error: error.message })
    }
  }
  console.log('Legacy migration:', result)
  return result
})()
