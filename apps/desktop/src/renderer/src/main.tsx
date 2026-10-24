import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Problems seen in the window are noted (without personal details) so they can be shared from Help.
window.addEventListener('error', (e) => { window.organizer.logError(e.message || 'Unknown error').catch(() => {}) })
window.addEventListener('unhandledrejection', (e) => { window.organizer.logError(e.reason instanceof Error ? e.reason.message : String(e.reason)).catch(() => {}) })

createRoot(document.getElementById('root')!).render(<App />)
