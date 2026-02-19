"use client"

import type { Column } from "@tanstack/react-table"
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"

import { cn } from "@/lib/utils"

interface SortableHeaderProps<TData, TValue> {
  column: Column<TData, TValue>
  children: React.ReactNode
  title?: string
  className?: string
}

export function SortableHeader<TData, TValue>({
  column,
  children,
  title,
  className,
}: SortableHeaderProps<TData, TValue>) {
  const sorted = column.getIsSorted()

  const handleClick = () => {
    column.toggleSorting(sorted === "asc")
  }

  return (
    <div className={cn("group relative", className)}>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-left font-medium hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
      >
        <span>{children}</span>
        {sorted === "asc" ? (
          <ArrowUp className="h-3.5 w-3.5 shrink-0" />
        ) : sorted === "desc" ? (
          <ArrowDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        )}
      </button>
      {title && (
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-1 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100">
          {title}
        </span>
      )}
    </div>
  )
}
