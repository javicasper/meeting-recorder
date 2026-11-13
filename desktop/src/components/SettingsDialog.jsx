import { useEffect, useRef, useState } from 'react'

const FIELDS = [
  { key: 'SONIOX_API_KEY', label: 'Clave de Soniox', hint: 'Transcripción (console.soniox.com).' },
  { key: 'OPENAI_API_KEY', label: 'Clave de OpenAI', hint: 'Actas y preguntas sobre la reunión.' },
]

// Desktop app only: API keys live in the app's settings file, not in a .env.
// Saving restarts the bundled backend and reloads the page.
export function SettingsDialog({ open, required, onClose }) {
  const dialogRef = useRef(null)
  const [values, setValues] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open) return dialog?.close()
    window.__TAURI__.core.invoke('get_settings').then(setValues).catch((e) => setError(String(e)))
    dialog?.showModal()
  }, [open])

  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await window.__TAURI__.core.invoke('save_settings', { settings: values })
      window.location.reload()
    } catch (e) {
      setError(String(e))
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="settingsDialog"
      onCancel={(event) => (required ? event.preventDefault() : onClose())}
    >
      <form onSubmit={save}>
        <h2>Ajustes</h2>
        {required && <p className="settingsIntro">Pon tus claves para poder transcribir y generar actas.</p>}
        {FIELDS.map((field) => (
          <label key={field.key} className="settingsField">
            <span>{field.label}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck="false"
              required
              value={values[field.key] || ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value.trim() }))}
            />
            <small>{field.hint}</small>
          </label>
        ))}
        {error && <p className="settingsError">{error}</p>}
        <div className="settingsActions">
          {!required && (
            <button type="button" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
