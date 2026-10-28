import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Icon } from './components/Icon.jsx'
import { RecordingItem } from './components/RecordingItem.jsx'
import { ThemeToggle } from './components/ThemeToggle.jsx'
import { Transcript } from './components/Transcript.jsx'
import { getInitialTheme, applyTheme } from './lib/theme.js'
import {
  getAllRecordingsFromDb,
  getAllTranscriptionsFromDb,
  saveRecordingToDb,
  saveTranscriptionToDb,
  deleteRecordingFromDb,
  deleteTranscriptionFromDb,
} from './lib/db.js'
import { formatClock, buildPackageFileName, buildMeetingMarkdown } from './lib/format.js'
import { startLiveTranscription } from './lib/liveTranscriber.js'
import { sonioxCostUsd, tokensToTurns, turnsToText } from './lib/turns.js'

// Capture options, remembered per browser.
const SOURCE_OPTIONS = [
  { key: 'screen', label: 'Pantalla', fallback: true },
  { key: 'pcAudio', label: 'Audio del PC', fallback: true },
  { key: 'mic', label: 'Micrófono', fallback: true },
  { key: 'live', label: 'Transcripción en directo', fallback: true },
]
const prefKey = (key) => `meeting-recorder-${key}`

const readPref = (key, fallback) => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === 'on'
  } catch {
    return fallback
  }
}

const writePref = (key, value) => {
  try {
    localStorage.setItem(key, value ? 'on' : 'off')
  } catch {
    // Preference just won't persist.
  }
}

const withoutKey = (object, key) => {
  if (!(key in object)) return object
  const next = { ...object }
  delete next[key]
  return next
}

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.detail || `Error en ${url}`)
  return payload
}

function App() {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [sources, setSources] = useState(() =>
    Object.fromEntries(SOURCE_OPTIONS.map((o) => [o.key, readPref(prefKey(o.key), o.fallback)]))
  )
  const [liveView, setLiveView] = useState(null)
  const [recordings, setRecordings] = useState([])
  const [transcriptionsById, setTranscriptionsById] = useState({})
  const [busyById, setBusyById] = useState({})
  const [activeInsightsId, setActiveInsightsId] = useState('')
  const [showTranscriptById, setShowTranscriptById] = useState({})
  const [theme, setTheme] = useState(getInitialTheme)

  const previewRef = useRef(null)
  const recorderRef = useRef(null)
  const liveRef = useRef(null)
  const streamRef = useRef(null)
  const sourceStreamsRef = useRef([])
  const audioContextRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const recordingsRef = useRef([])
  const secondsRef = useRef(0)

  const isRecording = status === 'recording'
  const isPaused = status === 'paused'
  const isActive = isRecording || isPaused

  const setBusy = (id, label) =>
    setBusyById((prev) => (label ? { ...prev, [id]: label } : withoutKey(prev, id)))

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const stopAllTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    sourceStreamsRef.current.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))
    sourceStreamsRef.current = []
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {})
    }
    audioContextRef.current = null
    if (previewRef.current) previewRef.current.srcObject = null
  }

  const startTimer = () => {
    clearTimer()
    timerRef.current = setInterval(() => {
      secondsRef.current += 1
      setSeconds(secondsRef.current)
    }, 1000)
  }

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    Object.entries(sources).forEach(([key, value]) => writePref(prefKey(key), value))
  }, [sources])

  useEffect(() => {
    recordingsRef.current = recordings
  }, [recordings])

  useEffect(() => {
    let mounted = true

    Promise.all([getAllRecordingsFromDb(), getAllTranscriptionsFromDb()])
      .then(([persistedRecordings, persistedTranscriptions]) => {
        const withUrls = persistedRecordings.map((recording) => ({
          ...recording,
          mediaKind:
            recording.mediaKind || (recording.blob?.type?.startsWith('audio/') ? 'audio' : 'video'),
          url: URL.createObjectURL(recording.blob),
        }))
        if (!mounted) {
          withUrls.forEach((recording) => URL.revokeObjectURL(recording.url))
          return
        }
        setRecordings(withUrls)
        const byId = Object.fromEntries(
          persistedTranscriptions.map((item) => [item.recordingId, item])
        )
        setTranscriptionsById(byId)
        return withUrls
      })
      .then(async (loaded = []) => {
        // Pick up file transcriptions still running (or finished) on the server.
        for (const recording of loaded) {
          const response = await fetch(`/api/transcriptions/${recording.id}`).catch(() => null)
          if (mounted && response?.ok) awaitFileTranscription(recording)
        }
      })
      .catch(() => mounted && setError('No se pudieron cargar las grabaciones guardadas.'))

    return () => {
      mounted = false
      stopAllTracks()
      clearTimer()
      recordingsRef.current.forEach((recording) => URL.revokeObjectURL(recording.url))
    }
    // Mount-only: loads history and resumes jobs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveTranscription = async (transcription) => {
    await saveTranscriptionToDb(transcription)
    setTranscriptionsById((prev) => ({ ...prev, [transcription.recordingId]: transcription }))
  }

  const updateTitle = async (recordingId, report) => {
    const title = String(report?.meeting_title || '').trim().slice(0, 80)
    const existing = recordingsRef.current.find((item) => item.id === recordingId)
    if (!title || !existing) return
    const { url: _url, ...stored } = existing
    await saveRecordingToDb({ ...stored, displayTitle: title })
    setRecordings((prev) =>
      prev.map((item) => (item.id === recordingId ? { ...item, displayTitle: title } : item))
    )
  }

  // Swaps the estimate for the real Soniox cost once its usage log shows up.
  const fetchExactCost = async (transcription) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(
        `/api/costs/${transcription.recordingId}?since=${encodeURIComponent(transcription.createdAt)}`
      ).catch(() => null)
      if (response?.ok) {
        const { cost_usd } = await response.json()
        await saveTranscription({
          ...transcription,
          estimated_transcription_cost_usd: cost_usd,
          transcription_cost_exact: true,
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10000))
    }
  }

  const generateReport = async (transcription) => {
    const { report, report_model, report_cost_usd } = await postJson('/api/reports', {
      speaker_turns: transcription.speaker_turns,
    })
    const withReport = {
      ...transcription,
      report,
      report_model,
      report_cost_usd,
      report_updated_at: new Date().toISOString(),
    }
    await saveTranscription(withReport)
    await updateTitle(transcription.recordingId, report)
    setActiveInsightsId(transcription.recordingId)
    return withReport
  }

  const buildTranscription = (recording, turns, model, costUsd) => ({
    recordingId: recording.id,
    createdAt: new Date().toISOString(),
    speaker_turns: turns,
    transcript_text: turnsToText(turns),
    transcription_model: model,
    estimated_transcription_cost_usd: costUsd,
  })

  // After a live session: keep its transcript and only generate the summary.
  const finishLive = async (recording, { tokens, complete }) => {
    try {
      const turns = tokensToTurns(tokens)
      if (!complete || turns.length === 0) {
        setError(
          'La transcripción en directo no se completó. Usa "Transcribir" sobre la grabación para procesar el archivo entero.'
        )
        return
      }
      const transcription = buildTranscription(
        recording,
        turns,
        'soniox stt-rt-v5 (directo)',
        sonioxCostUsd({
          audioSeconds: recording.durationSeconds,
          outputTokens: tokens.length,
          live: true,
        })
      )
      await saveTranscription(transcription)
      setBusy(recording.id, 'Generando resumen...')
      fetchExactCost(await generateReport(transcription))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el resumen.')
    } finally {
      setBusy(recording.id, '')
      setLiveView(null)
    }
  }

  const startRecording = async () => {
    const { screen, pcAudio, mic, live } = sources
    const mode = screen ? 'video' : 'audio'
    try {
      if (!screen && !pcAudio && !mic) throw new Error('Marca al menos una fuente.')
      setError('')
      setSeconds(0)
      secondsRef.current = 0
      sourceStreamsRef.current = []

      // PC audio comes through screen sharing, so it needs the share picker even without video.
      let displayStream = null
      if (screen || pcAudio) {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: pcAudio })
        sourceStreamsRef.current.push(displayStream)
      }

      let micStream = null
      if (mic) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        sourceStreamsRef.current.push(micStream)
      }

      const videoTracks = screen ? displayStream.getVideoTracks() : []
      const mixedStream = new MediaStream(videoTracks)
      const displayAudioTracks = pcAudio ? displayStream.getAudioTracks() : []
      const micAudioTracks = micStream?.getAudioTracks() || []

      if (pcAudio && displayAudioTracks.length === 0 && !mic) {
        throw new Error(
          'No llegó audio del PC: al compartir, marca "Compartir audio" (en pestañas o pantalla completa).'
        )
      }
      // The file keeps sources apart (left = mic, right = PC audio) so echo can be removed
      // later using the PC channel as reference; live transcription gets a mono mix.
      let liveAudioTrack = null
      if (displayAudioTracks.length + micAudioTracks.length === 0) {
        if (!screen) throw new Error('No se detectó audio para la grabación.')
      } else {
        const audioContext = new window.AudioContext()
        audioContextRef.current = audioContext
        const monoMix = audioContext.createMediaStreamDestination()
        const splitFile = audioContext.createMediaStreamDestination()
        splitFile.channelCount = 2
        const merger = audioContext.createChannelMerger(2)
        merger.connect(splitFile)
        const connect = (track, gainValue, channel) => {
          const source = audioContext.createMediaStreamSource(new MediaStream([track]))
          const gain = audioContext.createGain()
          gain.gain.value = gainValue
          source.connect(gain)
          gain.connect(monoMix)
          gain.connect(merger, 0, channel)
        }
        micAudioTracks.forEach((track) => connect(track, 1.2, 0))
        displayAudioTracks.forEach((track) => connect(track, 1, 1))
        mixedStream.addTrack(splitFile.stream.getAudioTracks()[0])
        liveAudioTrack = monoMix.stream.getAudioTracks()[0]
      }

      streamRef.current = mixedStream
      if (previewRef.current) previewRef.current.srcObject = mode === 'video' ? mixedStream : null

      const supportedTypes =
        mode === 'audio'
          ? ['audio/webm;codecs=opus', 'audio/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      const chosenType =
        supportedTypes.find((type) => MediaRecorder.isTypeSupported(type)) ||
        (mode === 'audio' ? 'audio/webm' : 'video/webm')

      const startedAt = new Date()
      const recordingId = `${startedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`
      const recorder = new MediaRecorder(mixedStream, { mimeType: chosenType })
      recorderRef.current = recorder
      chunksRef.current = []

      // Sharing is also how PC audio arrives: stopping it ends the recording.
      const screenVideoTrack = displayStream?.getVideoTracks()[0]
      if (screenVideoTrack) {
        screenVideoTrack.onended = () => {
          if (recorderRef.current?.state !== 'inactive') recorderRef.current.stop()
        }
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: chosenType })
        const timestamp = new Date()
        const recording = {
          id: recordingId,
          name: `reunion-${timestamp.toISOString().replaceAll(':', '-')}.webm`,
          displayTitle: '',
          createdAt: timestamp.toISOString(),
          mediaKind: mode,
          // Played back downmixed; see MediaPlayer.
          audioChannels: 'mic-left-pc-right',
          durationSeconds: secondsRef.current,
          sizeBytes: blob.size,
          blob,
        }

        try {
          await saveRecordingToDb(recording)
        } catch {
          setError('La grabación se hizo, pero no se pudo guardar en la base local.')
        }
        setRecordings((prev) => [{ ...recording, url: URL.createObjectURL(blob) }, ...prev])
        clearTimer()
        setStatus('idle')

        const live = liveRef.current
        liveRef.current = null
        // Live recorder reads the mixed track: flush it before tearing the tracks down.
        if (live) setBusy(recording.id, 'Cerrando transcripción en directo...')
        const liveResult = live ? await live.stop() : null
        stopAllTracks()
        if (liveResult) await finishLive(recording, liveResult)
      }

      recorder.onerror = () => {
        setError('Error en la grabación. Prueba de nuevo.')
        setStatus('idle')
        clearTimer()
        stopAllTracks()
      }

      if (live && liveAudioTrack) {
        try {
          setLiveView({ finalTokens: [], partialTokens: [] })
          liveRef.current = await startLiveTranscription(liveAudioTrack, {
            referenceId: recordingId,
            onUpdate: ({ finalTokens, partialTokens }) =>
              setLiveView({ finalTokens: [...finalTokens], partialTokens }),
            onError: (message) => setError(message),
          })
        } catch (err) {
          setLiveView(null)
          setError(
            `${err.message} Se graba igualmente; podrás transcribir el archivo al terminar.`
          )
        }
      }

      recorder.start(1000)
      setStatus('recording')
      startTimer()
    } catch (err) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Permiso denegado para compartir pantalla o usar el micrófono.'
          : err?.message || 'No se pudo iniciar la grabación.'
      )
      setStatus('idle')
      clearTimer()
      stopAllTracks()
    }
  }

  const pauseRecording = () => {
    if (recorderRef.current?.state !== 'recording') return
    recorderRef.current.pause()
    liveRef.current?.pause()
    clearTimer()
    setStatus('paused')
  }

  const resumeRecording = () => {
    if (recorderRef.current?.state !== 'paused') return
    recorderRef.current.resume()
    liveRef.current?.resume()
    startTimer()
    setStatus('recording')
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    clearTimer()
    setStatus('idle')
  }

  const deleteRecording = async (recording) => {
    try {
      await Promise.all([
        deleteRecordingFromDb(recording.id),
        deleteTranscriptionFromDb(recording.id),
      ])
      URL.revokeObjectURL(recording.url)
      setRecordings((prev) => prev.filter((item) => item.id !== recording.id))
      setTranscriptionsById((prev) => withoutKey(prev, recording.id))
      setShowTranscriptById((prev) => withoutKey(prev, recording.id))
      setActiveInsightsId((prev) => (prev === recording.id ? '' : prev))
    } catch {
      setError('No se pudo eliminar la grabación.')
    }
  }

  // Polls the server-side job; also used to resume after a page reload.
  const awaitFileTranscription = async (recording) => {
    setBusy(recording.id, 'Transcribiendo archivo...')
    try {
      for (;;) {
        const response = await fetch(`/api/transcriptions/${recording.id}`)
        const job = await response.json().catch(() => null)
        if (!response.ok) throw new Error(job?.detail || 'Se perdió la transcripción en curso.')
        if (job.status === 'error') throw new Error(job.detail || 'No se pudo transcribir.')
        if (job.status === 'done') {
          const transcription = buildTranscription(
            recording,
            job.result.speaker_turns,
            job.result.transcription_model,
            job.result.transcription_cost_usd
          )
          await saveTranscription(transcription)
          fetch(`/api/transcriptions/${recording.id}`, { method: 'DELETE' }).catch(() => {})
          setBusy(recording.id, 'Generando resumen...')
          fetchExactCost(await generateReport(transcription))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo transcribir.')
    } finally {
      setBusy(recording.id, '')
    }
  }

  // Whole file in one request (Soniox async, server-side job), then the summary.
  const transcribeRecording = async (recording, { force = false } = {}) => {
    if (transcriptionsById[recording.id] && !force) {
      setActiveInsightsId((prev) => (prev === recording.id ? '' : recording.id))
      return
    }

    try {
      setError('')
      setBusy(recording.id, 'Subiendo archivo...')
      const response = await fetch(`/api/transcriptions/${recording.id}`, {
        method: 'POST',
        headers: { 'x-file-name': recording.name },
        body: recording.blob,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || 'No se pudo enviar el archivo.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo transcribir.')
      setBusy(recording.id, '')
      return
    }
    await awaitFileTranscription(recording)
  }

  const regenerateSummary = async (recording) => {
    const existing = transcriptionsById[recording.id]
    if (!existing) return
    try {
      setError('')
      setBusy(recording.id, 'Rehaciendo resumen...')
      await generateReport(existing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo rehacer el resumen.')
    } finally {
      setBusy(recording.id, '')
    }
  }

  const downloadMeetingNotes = (recording) => {
    const transcription = transcriptionsById[recording.id]
    if (!transcription) return
    const markdown = buildMeetingMarkdown(recording, transcription)
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildPackageFileName(recording)
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const toggleTranscript = (recordingId) =>
    setShowTranscriptById((prev) => ({ ...prev, [recordingId]: !prev[recordingId] }))

  return (
    <div className="tvApp">
      <header className="tvHeader">
        <div className="tvHeaderInner">
          <a className="tvBrand" href="/" aria-label="Traventia Meetings">
            <img
              className="tvBrandLogo"
              src="/traventia-logo.svg"
              alt="Traventia"
              width="130"
              height="29"
            />
            <span className="tvBrandTag">meetings</span>
          </a>
          <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
        </div>
      </header>

      <main className="tvMain">
        <section className="panel">
          <fieldset className="sourceOptions" disabled={isActive}>
            {SOURCE_OPTIONS.map((option) => (
              <label key={option.key} className="sourceOption">
                <input
                  type="checkbox"
                  checked={sources[option.key]}
                  onChange={(event) =>
                    setSources((prev) => ({ ...prev, [option.key]: event.target.checked }))
                  }
                />
                {option.label}
              </label>
            ))}
          </fieldset>

          <div className="controls">
            <button className="primary" type="button" onClick={startRecording} disabled={isActive}>
              <Icon name="record" />
              Iniciar
            </button>
            <button type="button" onClick={pauseRecording} disabled={!isRecording}>
              <Icon name="pause" />
              Pausar
            </button>
            <button type="button" onClick={resumeRecording} disabled={!isPaused}>
              <Icon name="play" />
              Reanudar
            </button>
            <button className="danger" type="button" onClick={stopRecording} disabled={!isActive}>
              <Icon name="stop" />
              Detener
            </button>
          </div>

          <div className="statusRow">
            <span className={`badge ${status}`}>{status}</span>
            <span className="timer">{formatClock(seconds)}</span>
          </div>

          {sources.screen && (
            <video ref={previewRef} className="preview" autoPlay muted playsInline />
          )}

          {liveView && (
            <Transcript
              turns={tokensToTurns(liveView.finalTokens)}
              partialText={liveView.partialTokens.map((t) => t.text).join('')}
              follow
            />
          )}

          {error && <p className="error">{error}</p>}

          {recordings.length > 0 && (
            <section className="history">
              <h2>Grabaciones anteriores</h2>
              <ul>
                {recordings.map((recording) => (
                  <RecordingItem
                    key={recording.id}
                    recording={recording}
                    transcription={transcriptionsById[recording.id]}
                    busyLabel={busyById[recording.id]}
                    showTranscript={showTranscriptById[recording.id]}
                    isInsightsActive={activeInsightsId === recording.id}
                    onTranscribe={transcribeRecording}
                    onRegenerate={regenerateSummary}
                    onDownloadNotes={downloadMeetingNotes}
                    onDelete={deleteRecording}
                    onToggleTranscript={toggleTranscript}
                  />
                ))}
              </ul>
            </section>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
