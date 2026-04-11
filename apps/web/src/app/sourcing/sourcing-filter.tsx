"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useCallback } from "react";
import { Search } from "lucide-react";

export function SourcingSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentQ = searchParams.get("q") ?? "";

  const handleChange = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const sp = new URLSearchParams(searchParams.toString());
        if (value) {
          sp.set("q", value);
        } else {
          sp.delete("q");
        }
        // Reset to page 1 on search change
        sp.delete("page");
        const qs = sp.toString();
        router.push(qs ? `/sourcing?${qs}` : "/sourcing");
      }, 300);
    },
    [router, searchParams]
  );

  return (
    <div className="relative flex-1 max-w-md">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        placeholder="Search source checks..."
        defaultValue={currentQ}
        onChange={(e) => handleChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
      />
    </div>
  );
}
