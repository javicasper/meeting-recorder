import { useState } from 'react'
import { formatUsd } from '../lib/format.js'

// Questions to the AI about this meeting; answers come from its transcript and summary.
export function MeetingChat({ chat, onAsk }) {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    const text = question.trim()
    if (!text || asking) return
    setAsking(true)
    setError('')
    try {
      await onAsk(text)
      setQuestion('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo responder.')
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="insightBlock meetingChat">
      <h3>Pregunta sobre la reunión</h3>
      {chat.length > 0 && (
        <ul className="chatMessages">
          {chat.map((message, idx) => (
            <li key={idx} className={`chatMessage chatMessage-${message.role}`}>
              {message.content}
              {message.cost_usd != null && (
                <span className="chatCost">{formatUsd(message.cost_usd)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="chatForm" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event)
          }}
          placeholder="¿Qué se decidió sobre…? ¿Quién se encarga de…?"
          aria-label="Pregunta sobre la reunión"
          rows={2}
          disabled={asking}
        />
        <button type="submit" className="primary" disabled={asking || !question.trim()}>
          {asking ? 'Pensando…' : 'Preguntar'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
