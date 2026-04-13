"use client";

import { Component, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Scoped React error boundary for dashboard sections.
 *
 * Unlike the Next.js `error.tsx` convention (which replaces the whole
 * route), this catches render errors inside a single section and renders
 * a supplied fallback. Used by sections that read typed data off a
 * loosely-shaped payload (e.g. `snapshot.extra.idFormatAudit`) so a Zod
 * parse failure degrades gracefully instead of blanking the page.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    if (typeof console !== "undefined") {
      console.error("[SectionErrorBoundary]", error);
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
