import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'
import { formatClock } from '../lib/format.js'

export function MediaPlayer({ kind, src, fallbackDurationSeconds = 0 }) {
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
            {formatClock(currentTime)} / {formatClock(effectiveDuration)}
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
