import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { CaptureOverlay } from './CaptureOverlay'
import { DebugPanel } from './DebugPanel'
import { Preview } from './Preview'
import { Details } from './Details'
import { Properties } from './Properties'
import { UpscaleDialog } from './UpscaleDialog'
import './styles.css'

const view = new URLSearchParams(window.location.search).get('view')
document.documentElement.dataset.view = view ?? 'settings'

const surface = view === 'capture'
  ? <CaptureOverlay />
  : view === 'preview'
    ? <Preview />
    : view === 'debug'
      ? <DebugPanel />
      : view === 'properties'
        ? <Properties />
        : view === 'details'
          ? <Details />
          : view === 'upscale'
            ? <UpscaleDialog />
            : <App />

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {surface}
  </React.StrictMode>
)
