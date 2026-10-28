// Soniox tokens <-> speaker turns. Shared by the browser (live) and the API (file).

const GAP_MS = 2000

// Groups consecutive tokens from the same speaker into turns (seconds-based, like the stored format).
export const tokensToTurns = (tokens = []) => {
  const turns = []
  for (const token of tokens) {
    if (!token.text) continue
    const speaker = token.speaker ? `Hablante ${token.speaker}` : null
    const last = turns[turns.length - 1]
    if (last && last.speaker === speaker && token.start_ms - last.end * 1000 < GAP_MS) {
      last.text += token.text
      last.end = token.end_ms / 1000
    } else {
      turns.push({
        start: token.start_ms / 1000,
        end: token.end_ms / 1000,
        speaker,
        text: token.text.trimStart(),
      })
    }
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() })).filter((turn) => turn.text)
}

const clock = (seconds) => {
  const s = Math.floor(seconds)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export const turnsToText = (turns = []) =>
  turns
    .map((turn) => `[${clock(turn.start)}] ${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`)
    .join('\n')

// Soniox bills tokens, not minutes (USD per 1M tokens, from the billing dashboard).
const SONIOX_PRICES = {
  file: { audio: 1.5, text: 3.5 },
  live: { audio: 2, text: 4 },
}
const AUDIO_TOKENS_PER_SECOND = 1000 / 120
// ponytail: context (vocabulary) and output tokens are approximations; ~2% under the
// real bill. Recount CONTEXT_TOKENS if vocabulary.txt grows a lot.
const CONTEXT_TOKENS = 700

export const sonioxCostUsd = ({ audioSeconds, outputTokens, live = false }) => {
  const price = SONIOX_PRICES[live ? 'live' : 'file']
  return (
    (audioSeconds * AUDIO_TOKENS_PER_SECOND * price.audio +
      (outputTokens + CONTEXT_TOKENS) * price.text) /
    1e6
  )
}
