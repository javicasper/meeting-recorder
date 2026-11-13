import { describe, it, expect, beforeEach } from 'vitest'
import { getStoredTheme, getInitialTheme, applyTheme, STORAGE_KEY } from './theme.js'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('getStoredTheme', () => {
  it('returns null when nothing is stored', () => {
    expect(getStoredTheme()).toBeNull()
  })

  it('returns a valid stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    expect(getStoredTheme()).toBe('dark')
  })

  it('ignores invalid stored values', () => {
    localStorage.setItem(STORAGE_KEY, 'banana')
    expect(getStoredTheme()).toBeNull()
  })
})

describe('getInitialTheme', () => {
  it('prefers the stored value over the system default', () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    expect(getInitialTheme()).toBe('dark')
  })

  it('falls back to light when nothing is stored (no matchMedia in jsdom)', () => {
    expect(getInitialTheme()).toBe('light')
  })
})

describe('applyTheme', () => {
  it('sets the data-theme attribute and persists the choice', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')

    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })
})
