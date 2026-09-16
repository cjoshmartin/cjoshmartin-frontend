'use client'

import dynamic from 'next/dynamic'
import type { AsciiFluidProps } from '@/components/ui/ascii-fluid'

// AsciiFluid is a WebGL/shader-heavy decorative background. Loading it
// lazily (and skipping SSR, since it only ever renders client-side canvas
// output) keeps its bundle out of the critical hydration path for every
// page's real content.
const AsciiFluid = dynamic(
    () => import('@/components/ui/ascii-fluid').then((mod) => mod.AsciiFluid),
    { ssr: false }
)

export default function LazyAsciiFluid(props: AsciiFluidProps){
    return <AsciiFluid {...props} />
}
