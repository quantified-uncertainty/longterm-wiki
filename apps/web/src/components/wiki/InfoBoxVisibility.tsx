"use client";

import React, { createContext, useContext, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

interface InfoBoxVisibilityState {
  visible: boolean;
  setVisible: (v: boolean) => void;
}

const InfoBoxVisibilityContext = createContext<InfoBoxVisibilityState>({
  visible: true,
  setVisible: () => {},
});

export function InfoBoxVisibilityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(true);

  return (
    <InfoBoxVisibilityContext.Provider value={{ visible, setVisible }}>
      {children}
    </InfoBoxVisibilityContext.Provider>
  );
}

export function useInfoBoxVisibility() {
  return useContext(InfoBoxVisibilityContext);
}

/**
 * Header toggle — shows "Info" link when the InfoBox is hidden.
 * Placed next to "Updated" and "History" in the page header.
 */
export function InfoBoxToggle() {
  const { visible, setVisible } = useInfoBoxVisibility();

  if (visible) return null;

  return (
    <button
      onClick={() => setVisible(true)}
      className="page-meta-github cursor-pointer bg-transparent border-0 p-0"
    >
      <PanelRightOpen size={14} />
      Info
    </button>
  );
}

/**
 * Wraps InfoBox content — adds a hide button and reads visibility from context.
 */
export function HideableInfoBox({
  children,
}: {
  children: React.ReactNode;
}) {
  const { visible, setVisible } = useInfoBoxVisibility();

  if (!visible) return null;

  return (
    <div className="wiki-infobox relative float-right w-[280px] mb-4 ml-6 max-md:float-none max-md:w-full max-md:ml-0 max-md:mb-6">
      <button
        onClick={() => setVisible(false)}
        className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-white/70 hover:text-white/90 bg-transparent hover:bg-white/10 border-0 cursor-pointer transition-colors"
        title="Hide info box"
      >
        <PanelRightClose size={11} />
      </button>
      {children}
    </div>
  );
}
