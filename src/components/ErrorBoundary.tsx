import { Component, type ErrorInfo, type ReactNode } from "react";

// The last line of defence against a blank white page. Without this, any
// throw during render — a storage engine that refuses to be touched, an
// unexpected null — unmounts the whole React tree and leaves the guest
// staring at nothing, with no hint that a reload would fix it.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page page--center">
        <h1>Ada masalah</h1>
        <p>Aplikasi tidak dapat dipaparkan. Muat semula halaman dan cuba lagi.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Muat semula
        </button>
      </div>
    );
  }
}
