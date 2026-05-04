import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Last-resort safety net for unhandled promise rejections inside the
// overlay window. Specific catches still belong at the call site — this
// just ensures stray rejections show up in devtools instead of being
// swallowed silently.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[optix-overlay] unhandled promise rejection:', event.reason);
});

/** Tiny error boundary for the overlay. The overlay renders zero UI by
 *  default (only paints when the agent broadcasts a render payload), so
 *  the fallback is intentionally invisible — we just want to make sure a
 *  render exception doesn't tear down the whole window or block future
 *  renders once the boundary resets. The error is logged so devtools
 *  picks it up. */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[optix-overlay] render error:', error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) return null;
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing in overlay/index.html');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
