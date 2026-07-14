import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installBrowserPreviewApi } from './preview-api'
import './styles.css'

if (import.meta.env.DEV && !window.internshipOS) installBrowserPreviewApi()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
