// Recordings, transcriptions and chats are stored by the API (SQLite + media files),
// so every device sees the same history.

const request = async (url, init) => {
  const response = await fetch(url, init)
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.detail || `Error en ${url}`)
  }
  return response.status === 204 ? null : response.json()
}

const sendJson = (url, method, body) =>
  request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const mediaUrl = (id) => `/api/recordings/${encodeURIComponent(id)}/media`

// [{ ...recording, transcription, chat }], newest first.
export const getAllRecordingsFromDb = () => request('/api/recordings')

export const saveRecordingToDb = (recording) => {
  const { blob, url: _url, transcription: _t, chat: _c, ...meta } = recording
  return request(`/api/recordings/${encodeURIComponent(meta.id)}`, {
    method: 'PUT',
    headers: {
      'x-recording': encodeURIComponent(JSON.stringify({ ...meta, mimeType: blob.type })),
    },
    body: blob,
  })
}

export const updateRecordingInDb = (id, patch) =>
  sendJson(`/api/recordings/${encodeURIComponent(id)}`, 'PATCH', patch)

export const saveTranscriptionToDb = (transcription) =>
  sendJson(
    `/api/recordings/${encodeURIComponent(transcription.recordingId)}/transcription`,
    'PUT',
    transcription
  )

// Also removes its transcription and chat.
export const deleteRecordingFromDb = (id) =>
  request(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const askAboutRecording = async (id, question) =>
  (await sendJson(`/api/recordings/${encodeURIComponent(id)}/ask`, 'POST', { question })).chat
