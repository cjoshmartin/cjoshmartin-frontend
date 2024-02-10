'use client';
import { useCallback } from 'react';
import { mount } from './js_stlLoader';

export function STLFileArea({ value }: any) {
    const { scale, file } = value;
    const {url, title} = file;
    const containerRef = useCallback(mount, [])


    return <div ref={containerRef}/>;
}
