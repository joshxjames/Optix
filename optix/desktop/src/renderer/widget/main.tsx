import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Last-resort safety net for promises that bubble up unhandled. Specific
// catches still belong at the call site — this only exists so a stray
// rejection (e.g. an IPC handler we forgot to wrap) shows up in the
// devtools console instead of disappearing silently.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[optix-widget] unhandled promise rejection:', event.reason);
});

/** Top-level error boundary so a render exception in any descendant
 *  doesn't replace the document with a blank screen. The widget is the
 *  user's only entry point — if it dies, they have to right-click the
 *  tray to recover. The fallback uses the same CSS vars as the app so
 *  it follows whichever theme was applied at boot (see the inline
 *  script in `index.html` that primes `data-theme` from localStorage). */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[optix-widget] render error:', error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          padding: '16px',
          fontFamily: 'system-ui, sans-serif',
          background: 'var(--bg, #101218)',
          color: 'var(--fg, #f5f6f8)',
          minHeight: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
          Optix hit a render error.
        </div>
        <div
          style={{
            fontSize: '11px',
            opacity: 0.75,
            marginBottom: '12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {this.state.error.message || String(this.state.error)}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            border: '1px solid var(--fg, #f5f6f8)',
            background: 'transparent',
            color: 'var(--fg, #f5f6f8)',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing in widget/index.html');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
