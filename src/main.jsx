import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary.jsx'
import './index.css'

// PWA registration is intentionally disabled here. The generated manifest was being fetched
// through Vercel's SSO flow on production deployments, which caused the CORS failure and
// prevented normal app startup. The app still uses a same-origin manifest file for installability
// without triggering the Vercel redirect loop.

// A worker registered by an older build outlives the build that registered it, and serves
// that build's cached app. public/sw.js replaces it; this clears any that remain once the
// app is running at all. Best-effort: nothing here may stop the app from starting.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => registrations.forEach((r) => r.unregister()))
    .catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
