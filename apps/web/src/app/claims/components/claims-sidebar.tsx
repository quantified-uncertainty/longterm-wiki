"use client";

import { useState, useMemo, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Search, X } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  MobileSidebar,
  MobileSidebarTrigger,
  useMobileSidebar,
  useSidebar,
} from "@/components/ui/sidebar";
import type { NavSection } from "@/lib/internal-nav";
import type { ClaimsEntityItem } from "./claims-nav";

export { MobileSidebarTrigger };

const MAX_INITIAL_ENTITIES = 15;

function StaticNavSection({ section }: { section: NavSection }) {
  const pathname = usePathname();
  const isActive = section.items.some((item) => item.href === pathname);

  return (
    <Collapsible
      defaultOpen={section.defaultOpen || isActive}
      className="group/collapsible"
    >
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center justify-between hover:bg-accent hover:text-accent-foreground rounded-md transition-colors">
            <span>{section.title}</span>
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === item.href}
                    size="sm"
                  >
                    <Link href={item.href}>{item.label}</Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function ClaimsEntityList({ entities }: { entities: ClaimsEntityItem[] }) {
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  // Reset showAll when search changes
  useEffect(() => {
    setShowAll(false);
  }, [search]);

  const filtered = useMemo(() => {
    if (!search) return entities;
    const q = search.toLowerCase();
    return entities.filter((e) => e.title.toLowerCase().includes(q));
  }, [entities, search]);

  const hasMore = !showAll && filtered.length > MAX_INITIAL_ENTITIES;
  const displayed = hasMore ? filtered.slice(0, MAX_INITIAL_ENTITIES) : filtered;

  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center justify-between hover:bg-accent hover:text-accent-foreground rounded-md transition-colors">
            <span>Entities ({entities.length})</span>
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          {/* Search input */}
          <div className="px-2 pb-1 pt-1 relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search entities..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-7 pl-6 pr-6 text-xs bg-background border border-border rounded-sm focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <SidebarGroupContent>
            <SidebarMenu>
              {displayed.map((entity) => (
                <SidebarMenuItem key={entity.entityId}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === entity.href}
                    size="sm"
                  >
                    <Link href={entity.href} className="flex items-center justify-between">
                      <span className="truncate">{entity.title}</span>
                      <span className="ml-1 text-muted-foreground shrink-0 text-xs">
                        {entity.claimCount}
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {hasMore && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    onClick={() => setShowAll(true)}
                  >
                    <span className="text-muted-foreground">
                      Show all {filtered.length} entities…
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}

              {search && filtered.length === 0 && (
                <SidebarMenuItem>
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    No entities match &ldquo;{search}&rdquo;
                  </div>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function ClaimsSidebarNav({
  sections,
  entities,
}: {
  sections: NavSection[];
  entities: ClaimsEntityItem[];
}) {
  return (
    <SidebarContent className="pt-4">
      {sections.map((section) => (
        <StaticNavSection key={section.title} section={section} />
      ))}
      {entities.length > 0 && <ClaimsEntityList entities={entities} />}
    </SidebarContent>
  );
}

function MobileSidebarAutoClose() {
  const pathname = usePathname();
  const { setMobileOpen } = useMobileSidebar();

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  return null;
}

function DesktopExpandTrigger() {
  const { open } = useSidebar();
  if (open) return null;
  return (
    <div className="hidden md:block sticky top-16 z-20 self-start">
      <SidebarTrigger
        aria-label="Show sidebar"
        className="m-1 bg-background border border-border/60 shadow-sm rounded-md"
      />
    </div>
  );
}

export function ClaimsSidebar({
  sections,
  entities,
}: {
  sections: NavSection[];
  entities: ClaimsEntityItem[];
}) {
  return (
    <>
      <Sidebar className="sticky top-14 h-[calc(100vh-3.5rem)] border-r border-border/50 bg-muted/30">
        <div className="flex items-center justify-end px-2 py-1 border-b border-border/30">
          <SidebarTrigger
            aria-label="Hide sidebar"
            className="text-muted-foreground"
          />
        </div>
        <ClaimsSidebarNav sections={sections} entities={entities} />
      </Sidebar>

      <DesktopExpandTrigger />

      <MobileSidebar>
        <ClaimsSidebarNav sections={sections} entities={entities} />
      </MobileSidebar>

      <MobileSidebarAutoClose />
    </>
  );
}
