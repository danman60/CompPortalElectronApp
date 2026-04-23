import React from 'react'

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; compact?: boolean; onClose?: () => void },
  State
> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('UI crash:', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.compact) {
        return (
          <div style={{
            padding: '10px',
            background: '#1e1e2e',
            color: '#cdd6f4',
            height: '100%',
            fontFamily: 'monospace',
            fontSize: '11px',
            overflow: 'auto',
          }}>
            <div style={{ color: '#f38ba8', fontWeight: 700, marginBottom: 8 }}>
              Panel crashed
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {this.state.error?.message || 'Unknown renderer error'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                style={{
                  padding: '5px 10px',
                  background: '#89b4fa',
                  color: '#1e1e2e',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                }}
              >
                Retry
              </button>
              {this.props.onClose && (
                <button
                  onClick={this.props.onClose}
                  style={{
                    padding: '5px 10px',
                    background: '#6b1616',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                  }}
                >
                  Close Overlay
                </button>
              )}
            </div>
          </div>
        )
      }
      return (
        <div style={{
          padding: '40px',
          background: '#1e1e2e',
          color: '#cdd6f4',
          height: '100vh',
          fontFamily: 'monospace',
        }}>
          <h2 style={{ color: '#f38ba8' }}>Something went wrong</h2>
          <pre style={{
            background: '#313244',
            padding: '16px',
            borderRadius: '8px',
            overflow: 'auto',
            maxHeight: '200px',
            fontSize: '13px',
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '16px',
              padding: '8px 24px',
              background: '#89b4fa',
              color: '#1e1e2e',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
