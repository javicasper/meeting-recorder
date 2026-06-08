import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Icon } from './components/Icon.jsx'
import { RecordingItem } from './components/RecordingItem.jsx'
import {
  getAllRecordingsFromDb,
  getAllTranscriptionsFromDb,
  saveRecordingToDb,
  saveTranscriptionToDb,
  deleteRecordingFromDb,
  deleteTranscriptionFromDb,
} from './lib/db.js'
import {
  formatClock,
  formatSize,
  buildPackageFileName,
  buildTranscriptionKey,
  buildFullSummaryText,
} from './lib/format.js'

function App() {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [recordingMode, setRecordingMode] = useState('video')
  const [recordings, setRecordings] = useState([])
  const [transcriptionsById, setTranscriptionsById] = useState({})
  const [transcribingId, setTranscribingId] = useState('')
  const [regeneratingSummaryId, setRegeneratingSummaryId] = useState('')
  const [downloadingPackageId, setDownloadingPackageId] = useState('')
  const [activeInsightsId, setActiveInsightsId] = useState('')
  const [showTranscriptById, setShowTranscriptById] = useState({})
  const [processingTitleById, setProcessingTitleById] = useState({})
  const [transcriptionProgressById, setTranscriptionProgressById] = useState({})

  const previewRef = useRef(null)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const sourceStreamsRef = useRef([])
  const audioContextRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const recordingsRef = useRef([])
  const secondsRef = useRef(0)

  const isRecording = status === 'recording'
  const isPaused = status === 'paused'

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const stopAllTracks = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    sourceStreamsRef.current.forEach((sourceStream) => {
      sourceStream.getTracks().forEach((track) => track.stop())
    })
    sourceStreamsRef.current = []

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {})
    }
    audioContextRef.current = null

    if (previewRef.current) {
      previewRef.current.srcObject = null
    }
  }

  const startTimer = () => {
    clearTimer()
    timerRef.current = setInterval(() => {
      const nextValue = secondsRef.current + 1
      secondsRef.current = nextValue
      setSeconds(nextValue)
    }, 1000)
  }

  const updateRecordingTitleFromReport = async (recordingId, report) => {
    const suggestedTitle = report?.meeting_title || report?.topics?.[0]?.title || ''
    const normalizedTitle = suggestedTitle.trim().slice(0, 80)
    if (!normalizedTitle) return

    const existingRecording = recordings.find((item) => item.id === recordingId)
    if (!existingRecording) return

    const updatedRecording = {
      ...existingRecording,
      displayTitle: normalizedTitle,
    }

    await saveRecordingToDb(updatedRecording)
    setRecordings((prev) =>
      prev.map((item) =>
        item.id === recordingId ? { ...item, displayTitle: normalizedTitle } : item
      )
    )
  }

  const clearProcessingTitle = (recordingId) => {
    setProcessingTitleById((prev) => {
      if (!prev[recordingId]) return prev
      const next = { ...prev }
      delete next[recordingId]
      return next
    })
  }

  useEffect(() => {
    recordingsRef.current = recordings
  }, [recordings])

  useEffect(() => {
    let isActive = true

    const loadRecordings = async () => {
      try {
        const [persistedRecordings, persistedTranscriptions] = await Promise.all([
          getAllRecordingsFromDb(),
          getAllTranscriptionsFromDb(),
        ])
        const withUrls = persistedRecordings.map((recording) => ({
          ...recording,
          mediaKind:
            recording.mediaKind ||
            (recording.blob?.type?.startsWith('audio/') ? 'audio' : 'video'),
          url: URL.createObjectURL(recording.blob),
        }))
        const byRecordingId = Object.fromEntries(
          persistedTranscriptions.map((item) => [item.recordingId, item])
        )

        if (!isActive) {
          withUrls.forEach((recording) => URL.revokeObjectURL(recording.url))
          return
        }

        setRecordings(withUrls)
        setTranscriptionsById(byRecordingId)
      } catch {
        if (isActive) {
          setError('No se pudieron cargar las grabaciones guardadas.')
        }
      }
    }

    loadRecordings()

    return () => {
      isActive = false
      stopAllTracks()
      clearTimer()
      recordingsRef.current.forEach((recording) => {
        URL.revokeObjectURL(recording.url)
      })
    }
  }, [])

  const startRecording = async () => {
    const mode = recordingMode
    try {
      setError('')
      setSeconds(0)
      secondsRef.current = 0

      sourceStreamsRef.current = []

      let displayStream = null
      if (mode === 'video') {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
        sourceStreamsRef.current.push(displayStream)
      } else {
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          })
          sourceStreamsRef.current.push(displayStream)
        } catch {
          // In audio-only mode we can continue with mic only.
        }
      }

      let micStream = null
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        sourceStreamsRef.current.push(micStream)
      } catch {
        // Continue even if mic permission is denied.
      }

      if (!displayStream && !micStream) {
        throw new Error('No se obtuvo ninguna fuente de audio/vídeo')
      }

      const videoTracks =
        mode === 'video' && displayStream ? displayStream.getVideoTracks() : []
      const mixedStream = new MediaStream(videoTracks)

      const displayAudioTracks = displayStream ? displayStream.getAudioTracks() : []
      const micAudioTracks = micStream ? micStream.getAudioTracks() : []
      const hasAnyAudioTrack = displayAudioTracks.length > 0 || micAudioTracks.length > 0

      if (mode === 'audio' && !hasAnyAudioTrack) {
        throw new Error('No se detectó audio para la grabación')
      }

      if (hasAnyAudioTrack) {
        const audioContext = new window.AudioContext()
        audioContextRef.current = audioContext

        const destination = audioContext.createMediaStreamDestination()

        displayAudioTracks.forEach((track) => {
          const source = audioContext.createMediaStreamSource(new MediaStream([track]))
          const gain = audioContext.createGain()
          gain.gain.value = 1
          source.connect(gain)
          gain.connect(destination)
        })

        micAudioTracks.forEach((track) => {
          const source = audioContext.createMediaStreamSource(new MediaStream([track]))
          const gain = audioContext.createGain()
          gain.gain.value = 1.2
          source.connect(gain)
          gain.connect(destination)
        })

        const mixedAudioTrack = destination.stream.getAudioTracks()[0]
        if (mixedAudioTrack) {
          mixedStream.addTrack(mixedAudioTrack)
        }
      }

      streamRef.current = mixedStream

      if (previewRef.current) {
        previewRef.current.srcObject = mode === 'video' ? mixedStream : null
      }

      const supportedTypes =
        mode === 'audio'
          ? ['audio/webm;codecs=opus', 'audio/webm']
          : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      const chosenType =
        supportedTypes.find((type) => MediaRecorder.isTypeSupported(type)) ||
        (mode === 'audio' ? 'audio/webm' : 'video/webm')

      const recorder = new MediaRecorder(mixedStream, { mimeType: chosenType })
      recorderRef.current = recorder
      chunksRef.current = []

      const screenVideoTrack =
        mode === 'video' && displayStream ? displayStream.getVideoTracks()[0] : null
      if (screenVideoTrack && mode === 'video') {
        screenVideoTrack.onended = () => {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop()
          }
        }
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: chosenType })
        const url = URL.createObjectURL(blob)
        const ext = chosenType.includes('webm') ? 'webm' : 'mp4'
        const timestamp = new Date()

        const recording = {
          id: `${timestamp.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
          name: `reunion-${timestamp.toISOString().replaceAll(':', '-')}.${ext}`,
          displayTitle: '',
          createdAt: timestamp.toISOString(),
          mediaKind: mode,
          durationSeconds: secondsRef.current,
          sizeBytes: blob.size,
          blob,
        }

        try {
          await saveRecordingToDb(recording)
        } catch {
          setError('La grabación se hizo, pero no se pudo guardar en la base local.')
        }

        setRecordings((prev) => [{ ...recording, url }, ...prev])
        clearTimer()
        setStatus('idle')
        stopAllTracks()
      }

      recorder.onerror = () => {
        setError('Error en la grabación. Prueba de nuevo.')
        setStatus('idle')
        clearTimer()
        stopAllTracks()
      }

      recorder.start(1000)
      setStatus('recording')
      startTimer()
    } catch {
      setError(
        mode === 'audio'
          ? 'No se pudo iniciar la grabación de audio. Revisa permisos de micrófono y, si quieres audio del sistema, comparte pantalla con audio.'
          : 'No se pudo iniciar la grabación. Revisa permisos de pantalla y micrófono.'
      )
      setStatus('idle')
      clearTimer()
      stopAllTracks()
    }
  }

  const pauseRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.pause()
      clearTimer()
      setStatus('paused')
    }
  }

  const resumeRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'paused') {
      recorderRef.current.resume()
      startTimer()
      setStatus('recording')
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder) return

    if (recorder.state !== 'inactive') {
      recorder.stop()
    }

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
      setTranscriptionsById((prev) => {
        const next = { ...prev }
        delete next[recording.id]
        return next
      })
      setShowTranscriptById((prev) => {
        const next = { ...prev }
        delete next[recording.id]
        return next
      })
      setProcessingTitleById((prev) => {
        const next = { ...prev }
        delete next[recording.id]
        return next
      })
      setTranscriptionProgressById((prev) => {
        const next = { ...prev }
        delete next[recording.id]
        return next
      })
      setActiveInsightsId((prev) => (prev === recording.id ? '' : prev))
    } catch {
      setError('No se pudo eliminar la grabación.')
    }
  }

  const transcribeRecording = async (recording, options = {}) => {
    const { force = false } = options
    const existing = transcriptionsById[recording.id]
    if (existing && !force) {
      setActiveInsightsId((prev) => (prev === recording.id ? '' : recording.id))
      return
    }

    try {
      setError('')
      setTranscribingId(recording.id)
      setProcessingTitleById((prev) => ({
        ...prev,
        [recording.id]: 'Procesando transcripción...',
      }))
      const transcriptionKey = buildTranscriptionKey(recording)

      const formData = new FormData()
      let sourceBlob = recording.blob
      if (!sourceBlob && recording.url) {
        const blobResponse = await fetch(recording.url)
        sourceBlob = await blobResponse.blob()
      }

      if (!sourceBlob) {
        throw new Error('No se encontró el archivo de la grabación para transcribir.')
      }

      const blobType = sourceBlob.type || 'audio/webm'
      const file = new File([sourceBlob], recording.name, { type: blobType })
      formData.append('file', file)
      formData.append('transcription_key', transcriptionKey)

      const loadByKey = async () => {
        const statusResponse = await fetch(
          `/api/transcriptions/by-key/${encodeURIComponent(transcriptionKey)}`
        )
        if (!statusResponse.ok) {
          if (statusResponse.status === 404) return null
          throw new Error('No se pudo consultar estado de transcripción.')
        }
        return statusResponse.json()
      }

      const syncProgress = async () => {
        const record = await loadByKey()
        if (!record) return null

        setTranscriptionProgressById((prev) => ({
          ...prev,
          [recording.id]: record,
        }))
        if (record.stage_label) {
          setProcessingTitleById((prev) => ({
            ...prev,
            [recording.id]: record.stage_label,
          }))
        }
        return record
      }

      const waitForDoneResult = async (maxMs = 20 * 60 * 1000) => {
        const start = Date.now()
        while (Date.now() - start < maxMs) {
          const record = await syncProgress()
          if (record?.status === 'done' && record.result) {
            return record.result
          }
          if (record?.status === 'error') {
            throw new Error(record.error || 'Falló la transcripción.')
          }
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        throw new Error('La transcripción sigue en proceso. Reintenta en unos minutos.')
      }

      const intervalId = setInterval(() => {
        syncProgress().catch(() => {})
      }, 2000)
      await syncProgress()

      let result = null
      try {
        const response = await fetch('/api/transcriptions', {
          method: 'POST',
          body: formData,
        })

        if (response.status === 200) {
          // Cache hit: the API returned the finished result directly.
          result = await response.json()
        } else if (response.status === 202 || response.status === 409) {
          // Job queued (202) or already in progress (409): poll until done.
          result = await waitForDoneResult()
        } else {
          const errorPayload = await response.json().catch(() => null)
          if (response.status === 413) {
            const maxReadable =
              errorPayload?.max_human || errorPayload?.max_bytes || 'límite configurado'
            throw new Error(
              `El archivo es demasiado grande para transcribir (${formatSize(sourceBlob.size)}). Máximo permitido: ${maxReadable}.`
            )
          }
          throw new Error(errorPayload?.detail || 'transcription_error')
        }
      } catch (postError) {
        try {
          result = await waitForDoneResult(3 * 60 * 1000)
        } catch {
          throw postError
        }
      } finally {
        clearInterval(intervalId)
      }

      const payload = {
        recordingId: recording.id,
        createdAt: new Date().toISOString(),
        ...result,
      }

      await saveTranscriptionToDb(payload)
      setTranscriptionsById((prev) => ({ ...prev, [recording.id]: payload }))
      setShowTranscriptById((prev) => ({ ...prev, [recording.id]: false }))
      setTranscriptionProgressById((prev) => {
        const next = { ...prev }
        delete next[recording.id]
        return next
      })
      await updateRecordingTitleFromReport(recording.id, payload.report)
      setActiveInsightsId(recording.id)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'No se pudo transcribir. Comprueba que la API de transcripción está levantada y tiene OPENAI_API_KEY.'
      )
    } finally {
      setTranscribingId('')
      clearProcessingTitle(recording.id)
    }
  }

  const regenerateSummary = async (recording) => {
    const existing = transcriptionsById[recording.id]
    if (!existing) return

    try {
      setError('')
      setRegeneratingSummaryId(recording.id)
      setProcessingTitleById((prev) => ({
        ...prev,
        [recording.id]: 'Rehaciendo resumen...',
      }))

      const response = await fetch('/api/reports/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript_text: existing.transcript_text || '',
          speaker_turns: existing.speaker_turns || [],
        }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || 'report_regenerate_error')
      }

      const payload = await response.json()
      const merged = {
        ...existing,
        report: payload.report,
        report_model: payload.report_model,
        report_updated_at: new Date().toISOString(),
      }

      await saveTranscriptionToDb(merged)
      setTranscriptionsById((prev) => ({ ...prev, [recording.id]: merged }))
      await updateRecordingTitleFromReport(recording.id, merged.report)
      setActiveInsightsId(recording.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo rehacer el resumen.')
    } finally {
      setRegeneratingSummaryId('')
      clearProcessingTitle(recording.id)
    }
  }

  const downloadMeetingPackage = async (recording) => {
    const transcription = transcriptionsById[recording.id]
    if (!transcription) {
      setError('Primero transcribe la grabación para poder descargar el paquete.')
      return
    }

    try {
      setError('')
      setDownloadingPackageId(recording.id)

      const response = await fetch('/api/exports/meeting-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_title: recording.displayTitle || recording.name,
          transcript_text: transcription.transcript_text || '',
          summary_text:
            buildFullSummaryText(transcription.report) ||
            transcription.report?.summary ||
            '',
        }),
      })

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null)
        throw new Error(errorPayload?.detail || 'No se pudo generar el ZIP.')
      }

      const zipBlob = await response.blob()
      const objectUrl = URL.createObjectURL(zipBlob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = buildPackageFileName(recording)
      anchor.click()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo descargar el paquete.')
    } finally {
      setDownloadingPackageId('')
    }
  }

  const toggleTranscript = (recordingId) => {
    setShowTranscriptById((prev) => ({
      ...prev,
      [recordingId]: !prev[recordingId],
    }))
  }

  return (
    <div className="tvApp">
      <header className="tvHeader">
        <div className="tvHeaderInner">
          <a className="tvBrand" href="/" aria-label="Traventia Meetings">
            <span className="tvBrandDot" aria-hidden="true" />
            <span className="tvBrandName">traventia</span>
            <span className="tvBrandTag">meetings</span>
          </a>
          <span className="tvHeaderClaim">Graba · Transcribe · Resume</span>
        </div>
      </header>

      <main className="tvMain">
        <section className="panel">
        <div className="modeRow">
          <span>Modo:</span>
          <span className="modeText">Vídeo + audio</span>
          <label className="switch" aria-label="Cambiar modo de grabación">
            <input
              type="checkbox"
              checked={recordingMode === 'audio'}
              disabled={isRecording || isPaused}
              onChange={(event) => {
                setRecordingMode(event.target.checked ? 'audio' : 'video')
              }}
            />
            <span className="slider" />
          </label>
          <span className="modeText">Solo audio</span>
        </div>

        <div className="controls">
          <button
            className="primary"
            type="button"
            onClick={startRecording}
            disabled={isRecording || isPaused}
          >
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
          <button className="danger" type="button" onClick={stopRecording}>
            <Icon name="stop" />
            Detener
          </button>
        </div>

        <div className="statusRow">
          <span className={`badge ${status}`}>{status}</span>
          <span className="timer">{formatClock(seconds)}</span>
        </div>

        {recordingMode === 'video' && (
          <video ref={previewRef} className="preview" autoPlay muted playsInline />
        )}

        {recordings.length > 0 && (
          <section className="history">
            <h2>Grabaciones anteriores</h2>
            <ul>
              {recordings.map((recording) => (
                <RecordingItem
                  key={recording.id}
                  recording={recording}
                  transcription={transcriptionsById[recording.id]}
                  progress={transcriptionProgressById[recording.id]}
                  processingTitle={processingTitleById[recording.id]}
                  showTranscript={showTranscriptById[recording.id]}
                  isTranscribing={transcribingId === recording.id}
                  isRegenerating={regeneratingSummaryId === recording.id}
                  isDownloadingPackage={downloadingPackageId === recording.id}
                  isInsightsActive={activeInsightsId === recording.id}
                  onTranscribe={transcribeRecording}
                  onRegenerate={regenerateSummary}
                  onDownloadPackage={downloadMeetingPackage}
                  onDelete={deleteRecording}
                  onToggleTranscript={toggleTranscript}
                />
              ))}
            </ul>
          </section>
        )}

        {error && <p className="error">{error}</p>}
        </section>
      </main>

      <footer className="tvFooter">
        <div className="tvFooterInner">
          <span className="tvBrandName tvBrandName--footer">traventia</span>
          <p className="tvFooterCopy">© Traventia · Grabador de Reuniones</p>
        </div>
      </footer>
    </div>
  )
}

export default App
