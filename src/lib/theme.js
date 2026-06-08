// Light/dark theme handling: persisted preference + system fallback.

export const STORAGE_KEY = 'meeting-recorder-theme'

const isValid = (value) => value === 'light' || value === 'dark'

export const getStoredTheme = () => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isValid(value) ? value : null
  } catch {
    return null
  }
}

export const getSystemTheme = () => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

export const getInitialTheme = () => getStoredTheme() || getSystemTheme()

export const applyTheme = (theme) => {
  const next = isValid(theme) ? theme : 'light'
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', next)
  }
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return next
}
