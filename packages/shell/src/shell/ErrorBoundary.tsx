import { Component, type ReactNode } from 'react';
import { Button, MessageStrip } from '@enterprise-ui/react';

/** Keeps a failing module view or widget from taking down the shell (§43 error boundaries). */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; resetKey?: unknown }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error);
  }

  override render() {
    if (this.state.error)
      return (
        <MessageStrip
          tone="error"
          title={`${this.props.label} failed to render`}
          actions={
            <Button size="sm" variant="tertiary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        >
          {this.state.error.message}
        </MessageStrip>
      );
    return this.props.children;
  }
}
