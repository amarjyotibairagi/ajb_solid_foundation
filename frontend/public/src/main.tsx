import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@skeleton/ui/styles.css'
import './theme.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
)
