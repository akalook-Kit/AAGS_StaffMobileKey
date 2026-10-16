import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * If one screen (or one settings tab) fails, show what went wrong there and keep the rest of the portal working,
 * instead of a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[portal]', this.props.label ?? '', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="alert bad" role="alert" style={{ margin: '12px 0' }}>
        <strong>{this.props.label ? `${this.props.label} could not be shown.` : 'This screen could not be shown.'}</strong>
        <div className="small" style={{ marginTop: 4 }}>{this.state.error.message}</div>
        <div className="small muted" style={{ marginTop: 4 }}>The rest of the portal still works. Reload the page; if it happens again, send this message and the version number (bottom of the menu) to support.</div>
        <div className="row" style={{ marginTop: 8 }}><button className="btn small" onClick={() => this.setState({ error: null })}>Try again</button><button className="btn small" onClick={() => location.reload()}>Reload page</button></div>
      </div>
    );
  }
}
