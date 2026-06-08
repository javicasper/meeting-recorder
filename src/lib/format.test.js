import { describe, it, expect } from 'vitest'
import {
  formatClock,
  formatSize,
  slugify,
  buildPackageFileName,
  buildTranscriptionKey,
  buildFullSummaryText,
} from './format.js'

describe('formatClock', () => {
  it('formats seconds as mm:ss', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(5)).toBe('00:05')
    expect(formatClock(65)).toBe('01:05')
    expect(formatClock(3661)).toBe('61:01')
  })

  it('floors fractional seconds and clamps negatives', () => {
    expect(formatClock(9.9)).toBe('00:09')
    expect(formatClock(-3)).toBe('00:00')
  })

  it('returns 00:00 for non-finite input', () => {
    expect(formatClock(Infinity)).toBe('00:00')
    expect(formatClock(NaN)).toBe('00:00')
  })
})

describe('formatSize', () => {
  it('returns 0 B for falsy sizes', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(undefined)).toBe('0 B')
  })

  it('formats bytes with the right unit', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
})

describe('slugify', () => {
  it('lowercases, strips accents and collapses separators', () => {
    expect(slugify('Reunión de Diseño')).toBe('reunion-de-diseno')
    expect(slugify('  a//b  ')).toBe('a-b')
  })

  it('falls back when nothing usable remains', () => {
    expect(slugify('///', 'reunion')).toBe('reunion')
    expect(slugify('', 'fallback')).toBe('fallback')
  })
})

describe('buildPackageFileName', () => {
  it('uses the display title when present', () => {
    expect(buildPackageFileName({ displayTitle: 'Sprint Review', name: 'x.webm' })).toBe(
      'sprint-review-paquete.zip'
    )
  })

  it('falls back to the file name without extension', () => {
    expect(buildPackageFileName({ displayTitle: '', name: 'reunion-2026.webm', id: '1' })).toBe(
      'reunion-2026-paquete.zip'
    )
  })
})

describe('buildTranscriptionKey', () => {
  it('combines a sanitized id and byte size', () => {
    expect(buildTranscriptionKey({ id: 'abc-123', sizeBytes: 999 })).toBe('rec-abc-123-999')
  })

  it('sanitizes unusual ids and defaults size to 0', () => {
    expect(buildTranscriptionKey({ id: 'a b/c' })).toBe('rec-a_b_c-0')
  })
})

describe('buildFullSummaryText', () => {
  it('returns empty string for non-objects', () => {
    expect(buildFullSummaryText(null)).toBe('')
    expect(buildFullSummaryText('x')).toBe('')
  })

  it('renders the sections that are present', () => {
    const text = buildFullSummaryText({
      meeting_title: 'Plan',
      summary: 'Resumen aquí',
      key_points: ['punto 1'],
      action_items: [{ task: 'Hacer X', owner: 'Ana', due_date: '2026-01-01' }],
    })
    expect(text).toContain('Título: Plan')
    expect(text).toContain('Resumen ejecutivo:')
    expect(text).toContain('- punto 1')
    expect(text).toContain('- Hacer X | Responsable: Ana | Fecha: 2026-01-01')
  })
})
