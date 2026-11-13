// MediaRecorder look-alike backed by the desktop app (desktop/, Tauri + ffmpeg), so the
// recording flow in App.jsx stays the same. Only available inside the desktop window.

export const isDesktopApp = () => Boolean(window.__TAURI__?.core)

// Raw PCM that the desktop app streams while recording, for live transcription.
const LIVE_AUDIO_CONFIG = { audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 }

export const createDesktopRecorder = async ({ mic, pcAudio, live }) => {
  const { invoke, Channel } = window.__TAURI__.core
  const listeners = new Set()
  const onAudio = new Channel()
  onAudio.onmessage = (bytes) => {
    const chunk = new Uint8Array(bytes)
    listeners.forEach((send) => send(chunk))
  }

  // Rust errors arrive as plain strings.
  const call = (command, args) =>
    invoke(command, args).catch((error) => {
      throw error instanceof Error ? error : new Error(String(error))
    })

  await call('start_recording', { mic, pc: pcAudio, live, onAudio })

  const recorder = {
    state: 'recording',
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    // Capture already started in start_recording.
    start: () => {},
    pause: () => {
      recorder.state = 'paused'
      call('pause_recording').catch(fail)
    },
    resume: () => {
      recorder.state = 'recording'
      call('resume_recording').catch(fail)
    },
    stop: () => {
      if (recorder.state === 'inactive') return
      recorder.state = 'inactive'
      call('stop_recording')
        .then((buffer) => {
          recorder.ondataavailable?.({ data: new Blob([buffer], { type: recorder.mimeType }) })
          recorder.onstop?.()
        })
        .catch(fail)
    },
  }
  const fail = (error) => {
    console.error(error)
    recorder.state = 'inactive'
    recorder.onerror?.(error)
  }

  const liveSource = live
    ? { audioConfig: LIVE_AUDIO_CONFIG, attach: (send) => listeners.add(send) }
    : null
  return { recorder, liveSource }
}
