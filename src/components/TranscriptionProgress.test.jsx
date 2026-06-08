import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TranscriptionProgress } from './TranscriptionProgress.jsx'

describe('TranscriptionProgress', () => {
  it('renders nothing when there is no progress', () => {
    const { container } = render(<TranscriptionProgress progress={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing once the job is done', () => {
    const { container } = render(
      <TranscriptionProgress progress={{ status: 'done', progress_percent: 100 }} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the stage label, clamped percent and chunk counter', () => {
    render(
      <TranscriptionProgress
        progress={{
          status: 'running',
          stage_label: 'Transcribiendo audio (1/3)...',
          progress_percent: 140,
          processed_chunks: 1,
          chunk_count: 3,
        }}
      />
    )
    expect(screen.getByText('Transcribiendo audio (1/3)...')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('Bloques: 1/3')).toBeInTheDocument()
  })
})
