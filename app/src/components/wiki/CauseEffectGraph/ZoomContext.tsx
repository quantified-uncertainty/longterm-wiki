"use client";

/**
 * ZoomContext - Provides current zoom level to all child nodes
 *
 * Semantic zoom levels:
 * - "far"    (zoom < 0.25): Only colored shapes, no text
 * - "medium" (0.25-0.5):    Labels only
 * - "close"  (0.5-0.9):     Labels + brief descriptions
 * - "detail" (> 0.9):       Full detail with descriptions and sub-items
 */

import { createContext, useContext, type ReactNode } from 'react';

export type ZoomLevel = 'far' | 'medium' | 'close' | 'detail';

interface ZoomContextValue {
  zoom: number;
  zoomLevel: ZoomLevel;
}

const ZoomContext = createContext<ZoomContextValue>({
  zoom: 1,
  zoomLevel: 'detail',
});

export function useZoom(): ZoomContextValue {
  return useContext(ZoomContext);
}

export function getZoomLevel(zoom: number): ZoomLevel {
  if (zoom < 0.25) return 'far';
  if (zoom < 0.5) return 'medium';
  if (zoom < 0.9) return 'close';
  return 'detail';
}

interface ZoomProviderProps {
  zoom: number;
  children: ReactNode;
}

export function ZoomProvider({ zoom, children }: ZoomProviderProps) {
  const value: ZoomContextValue = {
    zoom,
    zoomLevel: getZoomLevel(zoom),
  };

  return (
    <ZoomContext.Provider value={value}>
      {children}
    </ZoomContext.Provider>
  );
}
