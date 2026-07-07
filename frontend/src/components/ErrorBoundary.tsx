import { Component, type ReactNode } from "react";

/**
 * Catches render errors in a section so a single broken view no longer whites
 * out the whole app. Resets automatically when `resetKey` changes (e.g. the
 * user switches section or filter), so navigating away recovers without a
 * full page reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string | number },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surfaced for debugging; the boundary handles the UI.
    console.error("Section render error:", error);
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="chart-card" style={{ textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <h2 style={{ margin: "0 0 6px", color: "var(--text)" }}>Не вдалося показати цей розділ</h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
            Спробуйте змінити фільтр або перейти в інший розділ — сторінку перезавантажувати не треба.
          </p>
          <pre style={{ textAlign: "left", fontSize: 12, color: "#dc2626", background: "var(--bg-subtle, rgba(220,38,38,0.06))", padding: 10, borderRadius: 8, overflowX: "auto", maxWidth: 640, margin: "0 auto 16px" }}>
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <button className="btn-primary" onClick={() => this.setState({ error: null })}>Спробувати знову</button>
        </div>
      );
    }
    return this.props.children;
  }
}
