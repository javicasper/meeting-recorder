// Streams an audio track to Soniox real-time STT while the meeting is recorded.
// ponytail: no reconnect; if the socket drops, the recording keeps going and the
// file can be transcribed afterwards with the regular (file) flow.

const WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const KEEPALIVE_MS = 10000
const FINISH_TIMEOUT_MS = 30000

export const startLiveTranscription = async (audioTrack, { referenceId, onUpdate, onError }) => {
  const sessionResponse = await fetch(
    `/api/live-session?ref=${encodeURIComponent(referenceId)}`,
    { method: 'POST' }
  )
  if (!sessionResponse.ok) throw new Error('No se pudo abrir la sesión de transcripción en directo.')
  const { api_key, config } = await sessionResponse.json()

  const finalTokens = []
  let failed = false
  let resolveFinished = () => {}
  const finished = new Promise((resolve) => {
    resolveFinished = resolve
  })

  const ws = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('No se pudo conectar con Soniox.'))
  })
  ws.send(JSON.stringify({ ...config, api_key }))

  const fail = (message) => {
    if (failed) return
    failed = true
    onError(message)
    resolveFinished()
  }

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.error_code) {
      fail(`Transcripción en directo interrumpida: ${message.error_message}`)
      return
    }
    const partial = []
    for (const token of message.tokens || []) {
      if (token.is_final) finalTokens.push(token)
      else partial.push(token)
    }
    onUpdate({ finalTokens, partialTokens: partial })
    if (message.finished) resolveFinished()
  }
  ws.onclose = () => resolveFinished()
  ws.onerror = () => fail('Se perdió la conexión de la transcripción en directo.')

  const recorder = new MediaRecorder(new MediaStream([audioTrack]), {
    mimeType: 'audio/webm;codecs=opus',
  })
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(event.data)
  }
  recorder.start(250)

  // Soniox closes idle sessions; keep it open while the recording is paused.
  const keepalive = setInterval(() => {
    if (recorder.state === 'paused' && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive' }))
    }
  }, KEEPALIVE_MS)

  return {
    pause: () => recorder.state === 'recording' && recorder.pause(),
    resume: () => recorder.state === 'paused' && recorder.resume(),
    // Resolves with all final tokens once Soniox has processed the tail of the audio.
    stop: async () => {
      clearInterval(keepalive)
      if (recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          recorder.onstop = resolve
          recorder.stop()
        })
      }
      if (ws.readyState === WebSocket.OPEN) ws.send('')
      await Promise.race([finished, new Promise((r) => setTimeout(r, FINISH_TIMEOUT_MS))])
      ws.close()
      return { tokens: finalTokens, complete: !failed }
    },
  }
}
