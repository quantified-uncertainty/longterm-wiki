"use client";

import { createContext, useContext } from "react";
import type { CitationQuote } from "@/lib/citation-data";

const CitationQuotesContext = createContext<CitationQuote[]>([]);

export function CitationQuotesProvider({
  quotes,
  children,
}: {
  quotes: CitationQuote[];
  children: React.ReactNode;
}) {
  return (
    <CitationQuotesContext.Provider value={quotes}>
      {children}
    </CitationQuotesContext.Provider>
  );
}

export function useCitationQuotes(): CitationQuote[] {
  return useContext(CitationQuotesContext);
}
