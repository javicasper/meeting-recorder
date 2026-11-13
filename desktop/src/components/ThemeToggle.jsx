import { Icon } from './Icon.jsx'

export function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark'
  const label = isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'

  return (
    <button
      type="button"
      className="themeToggle"
      onClick={onToggle}
      role="switch"
      aria-checked={isDark}
      aria-label={label}
      title={label}
    >
      <Icon name={isDark ? 'sun' : 'moon'} />
    </button>
  )
}
