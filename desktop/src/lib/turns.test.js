import { describe, expect, it } from 'vitest'
import { sonioxCostUsd, tokensToTurns, turnsToText } from './turns.js'

const token = (text, startMs, speaker = '1') => ({
  text,
  start_ms: startMs,
  end_ms: startMs + 100,
  speaker,
})

describe('tokensToTurns', () => {
  it('merges consecutive tokens of the same speaker and splits on speaker change', () => {
    const turns = tokensToTurns([
      token('Hola', 0),
      token(' qué', 200),
      token(' tal', 400),
      token(' Bien', 600, '2'),
    ])
    expect(turns).toEqual([
      { start: 0, end: 0.5, speaker: 'Hablante 1', text: 'Hola qué tal' },
      { start: 0.6, end: 0.7, speaker: 'Hablante 2', text: 'Bien' },
    ])
  })

  it('starts a new turn after a long silence from the same speaker', () => {
    expect(tokensToTurns([token('Uno', 0), token(' dos', 5000)])).toHaveLength(2)
  })

  it('keeps null speaker when diarization is missing', () => {
    expect(tokensToTurns([{ text: 'x', start_ms: 0, end_ms: 10 }])[0].speaker).toBeNull()
  })
})

describe('turnsToText', () => {
  it('prefixes clock and speaker', () => {
    expect(turnsToText([{ start: 65, speaker: 'Hablante 1', text: 'Hola' }])).toBe(
      '[01:05] Hablante 1: Hola'
    )
  })
})

describe('sonioxCostUsd', () => {
  it('lands within a few % of the real bill (84 min file: $0.1576)', () => {
    const cost = sonioxCostUsd({ audioSeconds: 5067.5, outputTokens: 25420 })
    expect(cost).toBeGreaterThan(0.15)
    expect(cost).toBeLessThan(0.16)
  })

  it('prices live higher than file', () => {
    const args = { audioSeconds: 600, outputTokens: 3000 }
    expect(sonioxCostUsd({ ...args, live: true })).toBeGreaterThan(sonioxCostUsd(args))
  })
})
