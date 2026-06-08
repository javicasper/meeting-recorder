import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

describe('frontend test harness', () => {
  it('renders into jsdom', () => {
    render(<p>hola</p>)
    expect(screen.getByText('hola')).toBeInTheDocument()
  })
})
