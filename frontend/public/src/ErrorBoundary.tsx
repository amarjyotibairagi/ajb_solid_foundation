import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { failed: boolean }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Public interface render failure', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f8fafc' }}>
        <section role="alert" style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, margin: '0 0 10px' }}>Your workspace could not be displayed.</h1>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '9px 16px', border: 0, borderRadius: 6, background: '#365fc7', color: '#fff', cursor: 'pointer' }}>
            Reload
          </button>
        </section>
      </main>
    )
  }
}
