export function Icon({ name }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  if (name === 'play') {
    return (
      <svg {...common}>
        <polygon points="7 4 20 12 7 20 7 4" />
      </svg>
    )
  }

  if (name === 'pause') {
    return (
      <svg {...common}>
        <line x1="8" y1="4" x2="8" y2="20" />
        <line x1="16" y1="4" x2="16" y2="20" />
      </svg>
    )
  }

  if (name === 'rewind') {
    return (
      <svg {...common}>
        <polyline points="11 19 2 12 11 5" />
        <polyline points="22 19 13 12 22 5" />
      </svg>
    )
  }

  if (name === 'forward') {
    return (
      <svg {...common}>
        <polyline points="13 19 22 12 13 5" />
        <polyline points="2 19 11 12 2 5" />
      </svg>
    )
  }

  if (name === 'volume') {
    return (
      <svg {...common}>
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.5 5.5a9 9 0 0 1 0 13" />
      </svg>
    )
  }

  if (name === 'mute') {
    return (
      <svg {...common}>
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <line x1="23" y1="9" x2="17" y2="15" />
        <line x1="17" y1="9" x2="23" y2="15" />
      </svg>
    )
  }

  if (name === 'fullscreen') {
    return (
      <svg {...common}>
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    )
  }

  if (name === 'download') {
    return (
      <svg {...common}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    )
  }

  if (name === 'archive') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    )
  }

  if (name === 'eye') {
    return (
      <svg {...common}>
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }

  if (name === 'refresh') {
    return (
      <svg {...common}>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.5 9a9 9 0 0 1 14.1-3.4L23 10" />
        <path d="M20.5 15a9 9 0 0 1-14.1 3.4L1 14" />
      </svg>
    )
  }

  if (name === 'trash') {
    return (
      <svg {...common}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    )
  }

  if (name === 'record') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
      </svg>
    )
  }

  if (name === 'stop') {
    return (
      <svg {...common}>
        <rect x="7" y="7" width="10" height="10" rx="1" />
      </svg>
    )
  }

  return null
}
