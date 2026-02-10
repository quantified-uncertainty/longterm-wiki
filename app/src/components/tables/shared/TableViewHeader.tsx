"use client";

import { cn } from "@/lib/utils";

interface Breadcrumb {
  label: string;
  href: string;
}

interface NavLink {
  label: string;
  href: string;
  active?: boolean;
}

interface TableViewHeaderProps {
  title: string;
  breadcrumbs: Breadcrumb[];
  navLinks?: NavLink[];
  className?: string;
}

/**
 * Shared header component for table views with breadcrumb navigation
 */
export function TableViewHeader({
  title,
  breadcrumbs,
  navLinks,
  className,
}: TableViewHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-50 flex items-center gap-4 px-6 py-3 border-b bg-muted/50 backdrop-blur-sm",
        className
      )}
    >
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm">
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.href} className="flex items-center gap-2">
            <a
              href={crumb.href}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {i === 0 ? `← ${crumb.label}` : crumb.label}
            </a>
            {i < breadcrumbs.length - 1 && (
              <span className="text-muted-foreground/50">|</span>
            )}
          </span>
        ))}
      </nav>

      {/* Title */}
      <h1 className="flex-1 text-lg font-semibold text-foreground">{title}</h1>

      {/* Nav Links */}
      {navLinks && navLinks.length > 0 && (
        <nav className="flex items-center gap-2">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                link.active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}
