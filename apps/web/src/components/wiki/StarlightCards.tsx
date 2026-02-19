import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface StarlightCardProps {
  title?: string;
  children?: ReactNode;
}

export function StarlightCard({ title, children }: StarlightCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {title && (
        <h3 className="mt-0 mb-2 text-base font-semibold">{title}</h3>
      )}
      <div className="text-sm text-muted-foreground [&>*:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}

interface CardGridProps {
  children?: ReactNode;
  stagger?: boolean;
}

export function CardGrid({ children }: CardGridProps) {
  return (
    <div className="my-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      {children}
    </div>
  );
}

interface LinkCardProps {
  title: string;
  href: string;
  description?: string;
}

export function LinkCard({ title, href, description }: LinkCardProps) {
  const isExternal = href.startsWith("http");
  const Comp = isExternal ? "a" : Link;
  const extraProps = isExternal
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};

  return (
    <Comp
      href={href}
      className={cn(
        "group my-2 block rounded-lg border border-border bg-card p-4",
        "no-underline transition-colors hover:border-foreground/20 hover:bg-muted/50"
      )}
      {...(extraProps as any)}
    >
      <span className="font-semibold text-foreground group-hover:underline">
        {title}
        {isExternal && <span className="ml-1 text-xs text-muted-foreground">↗</span>}
      </span>
      {description && (
        <span className="mt-1 block text-sm text-muted-foreground">
          {description}
        </span>
      )}
    </Comp>
  );
}
