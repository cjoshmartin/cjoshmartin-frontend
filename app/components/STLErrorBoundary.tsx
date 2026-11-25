'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface STLErrorBoundaryProps {
  /** File the viewer was loading, for the error log. */
  url: string;
  children: ReactNode;
}

interface STLErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a 3D model that fails to load (for example when the Sanity file CDN refuses the request
 * because the site's origin is not in the project's CORS origins) from taking down the whole page.
 * The failure is logged and a short note replaces the viewer.
 */
export class STLErrorBoundary extends Component<STLErrorBoundaryProps, STLErrorBoundaryState> {
  state: STLErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): STLErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`STL viewer: could not load ${this.props.url}`, error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <p style={{ marginTop: '0.5rem' }}><i>(the 3D model could not be loaded)</i></p>;
    }
    return this.props.children;
  }
}
