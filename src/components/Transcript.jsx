import { formatClock } from '../lib/format.js'

// Speaker turns as a readable transcript. `names` maps "Hablante N" -> real name when known.
// With `onSeek`, clicking a line jumps the player to that moment.
export function Transcript({ turns, names = {}, onSeek }) {
  return (
    <div className="transcript">
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
    </div>
  )
}
