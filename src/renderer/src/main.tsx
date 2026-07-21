import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installBrowserPreviewApi } from './preview-api'
import './styles.css'

const explicitBrowserPreview = new URLSearchParams(window.location.search).get('preview') === '1'
if (import.meta.env.DEV && !window.internshipOS && explicitBrowserPreview) installBrowserPreviewApi()

const root = document.getElementById('root')!

if (!window.internshipOS) {
  ReactDOM.createRoot(root).render(
    <div className="startup-state"><strong>Internship OS could not connect</strong><span>The Electron preload bridge did not load. Run npm run doctor in the project folder, then restart the app.</span></div>
  )
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
