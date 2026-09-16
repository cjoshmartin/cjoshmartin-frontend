'use client';

import dynamic from 'next/dynamic';

// STLFileArea pulls in three.js, @react-three/fiber, and @react-three/drei.
// Loading it lazily (and skipping SSR, since it's a WebGL canvas) keeps that
// bundle out of blog posts that never render a 3D model block.
export const STLFileArea = dynamic(
  () => import('./STLFileArea').then((mod) => mod.STLFileArea),
  {
    ssr: false,
    loading: () => <p>Loading 3D viewer...</p>,
  }
);
