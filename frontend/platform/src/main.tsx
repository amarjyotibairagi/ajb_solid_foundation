import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import AcceptInvite from './admin/AcceptInvite'
import ErrorBoundary from './ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{window.location.pathname === '/accept-invite' ? <AcceptInvite /> : <App />}</ErrorBoundary>
  </StrictMode>,
)
