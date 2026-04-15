import { useEffect, useRef, useState } from 'react'
import './App.css'

const DB_NAME = 'meeting-recorder-db'
const DB_VERSION = 2
const RECORDINGS_STORE = 'recordings'
const TRANSCRIPTIONS_STORE = 'transcriptions'

const openDatabase = () => {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB no disponible'))
      return
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        const store = db.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(TRANSCRIPTIONS_STORE)) {
        const store = db.createObjectStore(TRANSCRIPTIONS_STORE, {
          keyPath: 'recordingId',
        })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const getAllRecordingsFromDb = async () => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readonly')
    const store = transaction.objectStore(RECORDINGS_STORE)
    const request = store.getAll()

    request.onsuccess = () => {
      const sorted = request.result.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      resolve(sorted)
    }
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

const saveRecordingToDb = async (recording) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite')
    const store = transaction.objectStore(RECORDINGS_STORE)

    store.put(recording)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

const getAllTranscriptionsFromDb = async () => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(TRANSCRIPTIONS_STORE)) {
      db.close()
      resolve([])
      return
    }

    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readonly')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)
    const request = store.getAll()

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

const saveTranscriptionToDb = async (result) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readwrite')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)

    store.put(result)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

const deleteTranscriptionFromDb = async (recordingId) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readwrite')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)

    store.delete(recordingId)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

const deleteRecordingFromDb = async (recordingId) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite')
    const store = transaction.objectStore(RECORDINGS_STORE)

    store.delete(recordingId)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

const formatPlayerTime = (totalSeconds) => {
  if (!Number.isFinite(totalSeconds)) return '00:00'

  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function Icon({ name }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  if (name === 'play') {
    return (
      <svg {...common}>
        <polygon points="7 4 20 12 7 20 7 4" />
      </svg>
    )
  }

  if (name === 'pause') {
    return (
      <svg {...common}>
        <line x1="8" y1="4" x2="8" y2="20" />
        <line x1="16" y1="4" x2="16" y2="20" />
      </svg>
    )
  }

  if (name === 'rewind') {
    return (
      <svg {...common}>
        <polyline points="11 19 2 12 11 5" />
        <polyline points="22 19 13 12 22 5" />
      </svg>
    )
  }

  if (name === 'forward') {
    return (
      <svg {...common}>
        <polyline points="13 19 22 12 13 5" />
        <polyline points="2 19 11 12 2 5" />
      </svg>
    )
  }

  if (name === 'volume') {
    return (
      <svg {...common}>
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.5 5.5a9 9 0 0 1 0 13" />
      </svg>
    )
  }

  if (name === 'mute') {
    return (
      <svg {...common}>
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>
    )
  }

  if (name === 'fullscreen') {
    return (
      <svg {...common}>
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    )
  }

  if (name === 'download') {
    return (
      <svg {...common}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    )
  }

  if (name === 'archive') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    )
  }

  if (name === 'eye') {
    return (
      <svg {...common}>
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }

  if (name === 'refresh') {
    return (
      <svg {...common}>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
        <path d="M20.5 15a9 9 0 0 1-14.1 3.4L1 14" />
      </svg>
    )
  }

  if (name === 'trash') {
    return (
      <svg {...common}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    )
  }

  if (name === 'record') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
      </svg>
    )
  }

  if (name === 'stop') {
    return (
      <svg {...common}>
        <rect x="7" y="7" width="10" height="10" rx="1" />
      </svg>
    )
  }

  return null
}

function MediaPlayer({ kind, src, fallbackDurationSeconds = 0 }) {
  const mediaRef = useRef(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return

    const syncCurrentTime = () => setCurrentTime(media.currentTime || 0)
    const syncDuration = () => setDuration(media.duration || 0)
    const syncPlayState = () => setIsPlaying(!media.paused)
    const onEnded = () => setIsPlaying(false)

    media.addEventListener('timeupdate', syncCurrentTime)
    media.addEventListener('loadedmetadata', syncDuration)
    media.addEventListener('durationchange', syncDuration)
    media.addEventListener('play', syncPlayState)
    media.addEventListener('pause', syncPlayState)
    media.addEventListener('ended', onEnded)

    return () => {
      media.removeEventListener('timeupdate', syncCurrentTime)
      media.removeEventListener('loadedmetadata', syncDuration)
      media.removeEventListener('durationchange', syncDuration)
      media.removeEventListener('play', syncPlayState)
      media.removeEventListener('pause', syncPlayState)
      media.removeEventListener('ended', onEnded)
    }
  }, [])

  const togglePlay = async () => {
    const media = mediaRef.current
    if (!media) return

    if (media.paused) {
      try {
        await media.play()
      } catch {
        // Browsers can block autoplay without interaction.
      }
    } else {
      media.pause()
    }
  }

  const handleSeek = (event) => {
    const media = mediaRef.current
    if (!media) return

    const nextTime = Number(event.target.value)
    media.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const handleVolume = (event) => {
    const media = mediaRef.current
    if (!media) return

    const nextVolume = Number(event.target.value)
    media.volume = nextVolume
    media.muted = nextVolume === 0
    setVolume(nextVolume)
    setIsMuted(nextVolume === 0)
  }

  const toggleMute = () => {
    const media = mediaRef.current
    if (!media) return

    const nextMuted = !media.muted
    media.muted = nextMuted
    setIsMuted(nextMuted)
  }

  const jumpTime = (deltaSeconds) => {
    const media = mediaRef.current
    if (!media) return

    const nextTime = Math.max(0, media.currentTime + deltaSeconds)
    media.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const changePlaybackRate = (event) => {
    const media = mediaRef.current
    if (!media) return

    const nextRate = Number(event.target.value)
    media.playbackRate = nextRate
    setPlaybackRate(nextRate)
  }

  const toggleFullscreen = () => {
    if (kind !== 'video') return
    const media = mediaRef.current
    if (!media || !media.requestFullscreen) return
    media.requestFullscreen().catch(() => {})
  }

  const effectiveDuration =
    Number.isFinite(duration) && duration > 0 ? duration : fallbackDurationSeconds
  const canSeek = effectiveDuration > 0
  const seekProgress = canSeek ? (currentTime / effectiveDuration) * 100 : 0
  const volumeProgress = (isMuted ? 0 : volume) * 100

  return (
    <div className={`customPlayer ${kind} ${isPlaying ? 'playing' : ''}`}>
      {kind === 'video' ? (
        <div className="mediaViewport">
          <video ref={mediaRef} className="customMedia" src={src} preload="metadata" />
        </div>
      ) : (
        <audio ref={mediaRef} className="customMediaAudio" src={src} preload="metadata" />
      )}

      <div className="playerControls">
        <input
          className="playerSeek"
          style={{ '--progress': `${seekProgress}%` }}
          type="range"
          min="0"
          max={effectiveDuration}
          step="0.1"
          disabled={!canSeek}
          value={Math.min(currentTime, effectiveDuration)}
          onChange={handleSeek}
        />

        <div className="controlRowTop">
          <div className="mainButtons">
            <button
              type="button"
              className="iconBtn"
              onClick={() => jumpTime(-10)}
              aria-label="Retroceder 10 segundos"
              title="Retroceder 10 segundos"
            >
              <Icon name="rewind" />
            </button>
            <button
              type="button"
              className="playBtn"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              title={isPlaying ? 'Pausar' : 'Reproducir'}
            >
              <Icon name={isPlaying ? 'pause' : 'play'} />
              <span>{isPlaying ? 'Pausa' : 'Play'}</span>
            </button>
            <button
              type="button"
              className="iconBtn"
              onClick={() => jumpTime(10)}
              aria-label="Avanzar 10 segundos"
              title="Avanzar 10 segundos"
            >
              <Icon name="forward" />
            </button>
          </div>

          <span className="playerTime">
            {formatPlayerTime(currentTime)} / {formatPlayerTime(effectiveDuration)}
          </span>

          <div className="extraButtons">
            <label className="speedLabel">
              Velocidad
              <select value={playbackRate} onChange={changePlaybackRate}>
                <option value="1">1x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
              </select>
            </label>
            {kind === 'video' && (
              <button
                type="button"
                className="iconBtn"
                onClick={toggleFullscreen}
                aria-label="Pantalla completa"
                title="Pantalla completa"
              >
                <Icon name="fullscreen" />
              </button>
            )}
          </div>
        </div>

        <div className="controlRowBottom">
          <button
            type="button"
            className="iconBtn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Activar sonido' : 'Silenciar'}
            title={isMuted ? 'Activar sonido' : 'Silenciar'}
          >
            <Icon name={isMuted ? 'mute' : 'volume'} />
          </button>
          <input
            className="playerVolume"
            style={{ '--progress': `${volumeProgress}%` }}
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolume}
          />
        </div>
      </div>
    </div>
  )
}

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

  const formatTime = (totalSeconds) => {
    const mins = Math.floor(totalSeconds / 60)
    const secs = totalSeconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const formatDateTime = (isoDate) => {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(isoDate))
  }

  const formatSize = (bytes) => {
    if (!bytes) return '0 B'

    const units = ['B', 'KB', 'MB', 'GB']
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    )
    const value = bytes / 1024 ** index

    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
  }

  const buildPackageFileName = (recording) => {
    const rawBase =
      recording.displayTitle ||
      recording.name.replace(/\.[^/.]+$/, '') ||
      `reunion-${recording.id}`

    const safeBase = rawBase
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')

    return `${safeBase || 'reunion'}-paquete.zip`
  }

  const buildTranscriptionKey = (recording) => {
    const safeId = String(recording.id || 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80)
    const size = Number(recording.sizeBytes || 0)
    return `rec-${safeId}-${size}`
  }

  const buildFullSummaryText = (report) => {
    if (!report || typeof report !== 'object') {
      return ''
    }

    const lines = []
    const pushLine = (value = '') => lines.push(String(value))

    const meetingTitle = String(report.meeting_title || '').trim()
    if (meetingTitle) {
      pushLine(`Título: ${meetingTitle}`)
      pushLine()
    }

    const executiveSummary = String(report.summary || '').trim()
    if (executiveSummary) {
      pushLine('Resumen ejecutivo:')
      pushLine(executiveSummary)
      pushLine()
    }

    const keyPoints = Array.isArray(report.key_points) ? report.key_points : []
    if (keyPoints.length > 0) {
      pushLine('Puntos clave:')
      keyPoints.forEach((item) => pushLine(`- ${item}`))
      pushLine()
    }

    const topics = Array.isArray(report.topics) ? report.topics : []
    if (topics.length > 0) {
      pushLine('Temas tratados:')
      topics.forEach((topic, idx) => {
        pushLine(`- ${topic?.title || `Tema ${idx + 1}`}`)
        if (topic?.summary) pushLine(`  ${topic.summary}`)
        if (topic?.start_time_hint) pushLine(`  Inicio aprox.: ${topic.start_time_hint}`)
      })
      pushLine()
    }

    const decisions = Array.isArray(report.decisions) ? report.decisions : []
    if (decisions.length > 0) {
      pushLine('Decisiones:')
      decisions.forEach((item) => pushLine(`- ${item}`))
      pushLine()
    }

    const actionItems = Array.isArray(report.action_items) ? report.action_items : []
    if (actionItems.length > 0) {
      pushLine('Tareas:')
      actionItems.forEach((item) => {
        const task = item?.task || 'Tarea'
        const owner = item?.owner ? ` | Responsable: ${item.owner}` : ''
        const dueDate = item?.due_date ? ` | Fecha: ${item.due_date}` : ''
        pushLine(`- ${task}${owner}${dueDate}`)
      })
      pushLine()
    }

    const risks = Array.isArray(report.risks) ? report.risks : []
    if (risks.length > 0) {
      pushLine('Riesgos:')
      risks.forEach((item) => pushLine(`- ${item}`))
      pushLine()
    }

    const openQuestions = Array.isArray(report.open_questions)
      ? report.open_questions
      : []
    if (openQuestions.length > 0) {
      pushLine('Preguntas abiertas:')
      openQuestions.forEach((item) => pushLine(`- ${item}`))
      pushLine()
    }

    return lines.join('\n').trim()
  }

  const updateRecordingTitleFromReport = async (recordingId, report) => {
    const suggestedTitle =
      report?.meeting_title || report?.topics?.[0]?.title || ''
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
        throw new Error('No se obtuvo ninguna fuente de audio/video')
      }

      const videoTracks =
        mode === 'video' && displayStream
          ? displayStream.getVideoTracks()
          : []
      const mixedStream = new MediaStream(videoTracks)

      const displayAudioTracks = displayStream ? displayStream.getAudioTracks() : []
      const micAudioTracks = micStream ? micStream.getAudioTracks() : []
      const hasAnyAudioTrack = displayAudioTracks.length > 0 || micAudioTracks.length > 0

      if (mode === 'audio' && !hasAnyAudioTrack) {
        throw new Error('No se detecto audio para la grabacion')
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
          : [
              'video/webm;codecs=vp9,opus',
              'video/webm;codecs=vp8,opus',
              'video/webm',
            ]
      const chosenType =
        supportedTypes.find((type) => MediaRecorder.isTypeSupported(type)) ||
        (mode === 'audio' ? 'audio/webm' : 'video/webm')

      const recorder = new MediaRecorder(mixedStream, { mimeType: chosenType })
      recorderRef.current = recorder
      chunksRef.current = []

      const screenVideoTrack =
        mode === 'video' && displayStream
          ? displayStream.getVideoTracks()[0]
          : null
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
          setError('La grabacion se hizo, pero no se pudo guardar en la base local.')
        }

        setRecordings((prev) => [{ ...recording, url }, ...prev])
        clearTimer()
        setStatus('idle')
        stopAllTracks()
      }

      recorder.onerror = () => {
        setError('Error en la grabacion. Prueba de nuevo.')
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
          ? 'No se pudo iniciar la grabacion de audio. Revisa permisos de microfono y, si quieres audio del sistema, comparte pantalla con audio.'
          : 'No se pudo iniciar la grabacion. Revisa permisos de pantalla y microfono.'
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
      setError('No se pudo eliminar la grabacion.')
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
        throw new Error('No se encontro el archivo de la grabacion para transcribir.')
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

        if (response.ok) {
          result = await response.json()
        } else if (response.status === 409) {
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
          : 'No se pudo transcribir. Comprueba que la API de transcripcion está levantada y tiene OPENAI_API_KEY.'
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
      setError(
        error instanceof Error ? error.message : 'No se pudo rehacer el resumen.'
      )
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
      setError(
        error instanceof Error ? error.message : 'No se pudo descargar el paquete.'
      )
    } finally {
      setDownloadingPackageId('')
    }
  }

  return (
    <main className="app">
      <section className="panel">
        <h1>Grabador de Reuniones</h1>
        <p className="subtitle">Captura pantalla y audio en una sola grabacion.</p>

        <div className="modeRow">
          <span>Modo:</span>
          <span className="modeText">Video + audio</span>
          <label className="switch" aria-label="Cambiar modo de grabacion">
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
          <span className="timer">{formatTime(seconds)}</span>
        </div>

        {recordingMode === 'video' && (
          <video ref={previewRef} className="preview" autoPlay muted playsInline />
        )}

        {recordings.length > 0 && (
          <section className="history">
            <h2>Grabaciones anteriores</h2>
            <ul>
              {recordings.map((recording) => (
                <li key={recording.id} className="historyItem">
                  <div className="historyTop">
                    <div>
                      <p className="historyTitle">
                        {processingTitleById[recording.id] ||
                          recording.displayTitle ||
                          recording.name}
                      </p>
                      <p className="historyMeta">
                        {formatDateTime(recording.createdAt)} ·{' '}
                        {formatTime(recording.durationSeconds)} ·{' '}
                        {formatSize(recording.sizeBytes)}
                      </p>
                    </div>
                    <div className="historyActions">
                      <a
                        href={recording.url}
                        download={recording.name}
                        className="historyIconAction historyDownload"
                        aria-label="Descargar grabación original"
                        title="Descargar grabación original"
                      >
                        <Icon name="download" />
                      </a>
                      <button
                        type="button"
                        className="historyIconAction historyPackage"
                        disabled={
                          downloadingPackageId === recording.id ||
                          !transcriptionsById[recording.id]
                        }
                        onClick={() => {
                          downloadMeetingPackage(recording)
                        }}
                        title={
                          transcriptionsById[recording.id]
                            ? 'Descargar ZIP (transcripción + resumen)'
                            : 'Transcribe primero para generar el ZIP'
                        }
                        aria-label={
                          transcriptionsById[recording.id]
                            ? 'Descargar ZIP de la reunión'
                            : 'Descargar ZIP deshabilitado: falta transcripción'
                        }
                      >
                        <Icon name="archive" />
                      </button>
                      <button
                        type="button"
                        className="historyIconAction historyTranscribe"
                        disabled={transcribingId === recording.id}
                        onClick={() => {
                          transcribeRecording(recording)
                        }}
                        title={
                          transcribingId === recording.id
                            ? 'Transcribiendo...'
                            : transcriptionsById[recording.id]
                              ? activeInsightsId === recording.id
                                ? 'Ocultar datos'
                                : 'Ver datos'
                              : 'Transcribir'
                        }
                        aria-label={
                          transcribingId === recording.id
                            ? 'Transcribiendo'
                            : transcriptionsById[recording.id]
                              ? activeInsightsId === recording.id
                                ? 'Ocultar datos'
                                : 'Ver datos'
                              : 'Transcribir'
                        }
                      >
                        <Icon name="eye" />
                      </button>
                      {transcriptionsById[recording.id] && (
                        <button
                          type="button"
                          className="historyIconAction historyRegenerate"
                          disabled={transcribingId === recording.id}
                          onClick={() => {
                            transcribeRecording(recording, { force: true })
                          }}
                          title="Regenerar transcripción y resumen"
                          aria-label="Regenerar transcripción y resumen"
                        >
                          <Icon name="refresh" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="historyIconAction historyDelete"
                        onClick={() => {
                          deleteRecording(recording)
                        }}
                        title="Eliminar"
                        aria-label="Eliminar"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </div>
                  {transcriptionProgressById[recording.id]?.status &&
                    transcriptionProgressById[recording.id]?.status !== 'done' && (
                      <div className="transcriptionProgress">
                        <div className="transcriptionProgressTop">
                          <span>
                            {transcriptionProgressById[recording.id].stage_label ||
                              'Procesando...'}
                          </span>
                          <span>
                            {Math.max(
                              0,
                              Math.min(
                                100,
                                Number(
                                  transcriptionProgressById[recording.id]
                                    .progress_percent || 0
                                )
                              )
                            )}
                            %
                          </span>
                        </div>
                        <div className="transcriptionProgressBar">
                          <span
                            style={{
                              width: `${Math.max(
                                0,
                                Math.min(
                                  100,
                                  Number(
                                    transcriptionProgressById[recording.id]
                                      .progress_percent || 0
                                  )
                                )
                              )}%`,
                            }}
                          />
                        </div>
                        {Number(
                          transcriptionProgressById[recording.id].chunk_count || 0
                        ) > 0 && (
                          <p className="transcriptionProgressMeta">
                            Bloques:{' '}
                            {Number(
                              transcriptionProgressById[recording.id]
                                .processed_chunks || 0
                            )}
                            /
                            {Number(
                              transcriptionProgressById[recording.id].chunk_count || 0
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  <MediaPlayer
                    kind={recording.mediaKind}
                    src={recording.url}
                    fallbackDurationSeconds={recording.durationSeconds}
                  />
                  {activeInsightsId === recording.id && transcriptionsById[recording.id] && (
                    <section className="insightsPanel">
                      <p className="insightsMeta">
                        Modelo: {transcriptionsById[recording.id].transcription_model || '-'} ·
                        Coste: $
                        {Number(
                          transcriptionsById[recording.id]
                            .estimated_transcription_cost_usd || 0
                        ).toFixed(6)}
                      </p>
                      <p className="insightsSummary">
                        {transcriptionsById[recording.id].report?.summary ||
                          'Sin resumen'}
                      </p>

                      {Array.isArray(transcriptionsById[recording.id].report?.key_points) &&
                        transcriptionsById[recording.id].report.key_points.length > 0 && (
                          <div className="insightBlock">
                            <h3>Puntos clave</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.key_points.map(
                                (item, idx) => (
                                  <li key={`${recording.id}-kp-${idx}`}>{item}</li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      {Array.isArray(transcriptionsById[recording.id].report?.topics) &&
                        transcriptionsById[recording.id].report.topics.length > 0 && (
                          <div className="insightBlock">
                            <h3>Temas tratados</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.topics.map(
                                (topic, idx) => (
                                  <li key={`${recording.id}-topic-${idx}`}>
                                    <strong>{topic.title || `Tema ${idx + 1}`}</strong>: {topic.summary || ''}
                                  </li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      {Array.isArray(transcriptionsById[recording.id].report?.decisions) &&
                        transcriptionsById[recording.id].report.decisions.length > 0 && (
                          <div className="insightBlock">
                            <h3>Decisiones</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.decisions.map(
                                (item, idx) => (
                                  <li key={`${recording.id}-dec-${idx}`}>{item}</li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      {Array.isArray(
                        transcriptionsById[recording.id].report?.action_items
                      ) &&
                        transcriptionsById[recording.id].report.action_items.length > 0 && (
                          <div className="insightBlock">
                            <h3>Tareas</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.action_items.map(
                                (item, idx) => (
                                  <li key={`${recording.id}-task-${idx}`}>
                                    <strong>{item.task || 'Tarea'}</strong>
                                    {item.owner ? ` · Responsable: ${item.owner}` : ''}
                                    {item.due_date ? ` · Fecha: ${item.due_date}` : ''}
                                  </li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      {Array.isArray(transcriptionsById[recording.id].report?.risks) &&
                        transcriptionsById[recording.id].report.risks.length > 0 && (
                          <div className="insightBlock">
                            <h3>Riesgos</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.risks.map(
                                (item, idx) => (
                                  <li key={`${recording.id}-risk-${idx}`}>{item}</li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      {Array.isArray(
                        transcriptionsById[recording.id].report?.open_questions
                      ) &&
                        transcriptionsById[recording.id].report.open_questions.length >
                          0 && (
                          <div className="insightBlock">
                            <h3>Preguntas abiertas</h3>
                            <ul>
                              {transcriptionsById[recording.id].report.open_questions.map(
                                (item, idx) => (
                                  <li key={`${recording.id}-q-${idx}`}>{item}</li>
                                )
                              )}
                            </ul>
                          </div>
                        )}

                      <div className="insightsActions">
                        <button
                          type="button"
                          className="historyRegenerate"
                          disabled={regeneratingSummaryId === recording.id}
                          onClick={() => {
                            regenerateSummary(recording)
                          }}
                        >
                          {regeneratingSummaryId === recording.id
                            ? 'Rehaciendo resumen...'
                            : 'Rehacer resumen'}
                        </button>
                        <button
                          type="button"
                          className="historyTranscribe"
                          onClick={() => {
                            setShowTranscriptById((prev) => ({
                              ...prev,
                              [recording.id]: !prev[recording.id],
                            }))
                          }}
                        >
                          {showTranscriptById[recording.id]
                            ? 'Ocultar transcripción'
                            : 'Mostrar transcripción'}
                        </button>
                      </div>

                      {showTranscriptById[recording.id] && (
                        <p className="insightsTranscript">
                          {transcriptionsById[recording.id].transcript_text || 'Sin texto'}
                        </p>
                      )}
                    </section>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  )
}

export default App
