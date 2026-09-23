import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// The desktop/CLI build only ever renders the tool itself — no marketing
// pages, no router. Those live in the separate tracinator-site repo, which
// vendors this UI source and wraps it in its own AppRouter alongside
// Landing/Docs/Download. See tracinator-site's AppRouter.tsx.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
