import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InsightsPanel } from './InsightsPanel.jsx'

const baseTranscription = {
  transcription_model: 'whisper-1',
  estimated_transcription_cost_usd: 0.0123,
  transcript_text: 'texto completo de la transcripción',
  report: {
    summary: 'Resumen de la reunión',
    key_points: ['Punto A', 'Punto B'],
    action_items: [{ task: 'Hacer X', owner: 'Ana' }],
    topics: [],
    decisions: [],
    risks: [],
    open_questions: [],
  },
}

const renderPanel = (overrides = {}) =>
  render(
    <InsightsPanel
      recordingId="rec-1"
      transcription={baseTranscription}
      regenerating={false}
      onRegenerate={() => {}}
      showTranscript={false}
      onToggleTranscript={() => {}}
      {...overrides}
    />
  )

describe('InsightsPanel', () => {
  it('renders the summary and the populated report sections', () => {
    renderPanel()
    expect(screen.getByText('Resumen de la reunión')).toBeInTheDocument()
    expect(screen.getByText('Puntos clave')).toBeInTheDocument()
    expect(screen.getByText('Punto A')).toBeInTheDocument()
    expect(screen.getByText('Tareas')).toBeInTheDocument()
    expect(screen.getByText('Hacer X')).toBeInTheDocument()
  })

  it('omits empty report sections', () => {
    renderPanel()
    expect(screen.queryByText('Decisiones')).not.toBeInTheDocument()
    expect(screen.queryByText('Riesgos')).not.toBeInTheDocument()
  })

  it('hides the transcript until toggled on', () => {
    const { rerender } = renderPanel({ showTranscript: false })
    expect(screen.queryByText(/texto completo/)).not.toBeInTheDocument()

    rerender(
      <InsightsPanel
        recordingId="rec-1"
        transcription={baseTranscription}
        regenerating={false}
        onRegenerate={() => {}}
        showTranscript
        onToggleTranscript={() => {}}
      />
    )
    expect(screen.getByText(/texto completo/)).toBeInTheDocument()
  })

  it('fires the regenerate handler on click', async () => {
    const onRegenerate = vi.fn()
    renderPanel({ onRegenerate })
    await userEvent.click(screen.getByRole('button', { name: 'Rehacer resumen' }))
    expect(onRegenerate).toHaveBeenCalledOnce()
  })
})
