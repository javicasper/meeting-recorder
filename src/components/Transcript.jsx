import { useEffect, useRef } from 'react'
import { formatClock } from '../lib/format.js'

// Speaker turns as a readable transcript. `names` maps "Hablante N" -> real name when known.
// With `onSeek`, clicking a line jumps the player to that moment.
export function Transcript({ turns, partialText = '', names = {}, follow = false, onSeek }) {
  const endRef = useRef(null)

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [follow, turns.length, partialText])

  return (
    <div className={`transcript${follow ? ' transcriptLive' : ''}`}>
      {turns.length === 0 && !partialText && <p className="transcriptEmpty">Escuchando…</p>}
      {turns.map((turn, idx) => (
        <p
          key={`${turn.start}-${idx}`}
          {...(onSeek && {
            className: 'transcriptSeekable',
            role: 'button',
            tabIndex: 0,
            title: `Reproducir desde ${formatClock(turn.start)}`,
            onClick: () => onSeek(turn.start),
            onKeyDown: (event) => event.key === 'Enter' && onSeek(turn.start),
          })}
        >
          <span className="transcriptTime">{formatClock(turn.start)}</span>
          {turn.speaker && (
            <strong className="transcriptSpeaker">{names[turn.speaker] || turn.speaker}:</strong>
          )}{' '}
          {turn.text}
        </p>
      ))}
      {partialText && <p className="transcriptPartial">{partialText}</p>}
      <span ref={endRef} />
    </div>
  )
}
