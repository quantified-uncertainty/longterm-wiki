"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
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
  MobileSidebar,
  MobileSidebarTrigger,
  useMobileSidebar,
} from "@/components/ui/sidebar";
import type { NavSection } from "@/lib/internal-nav";

function SidebarNavSection({ section }: { section: NavSection }) {
  const pathname = usePathname();
  const isActive = section.items.some((item) => item.href === pathname);

  return (
    <Collapsible
      defaultOpen={section.defaultOpen || isActive}
      className="group/collapsible"
    >
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center justify-between">
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

function SidebarNav({ sections }: { sections: NavSection[] }) {
  return (
    <SidebarContent className="pt-2">
      {sections.map((section) => (
        <SidebarNavSection key={section.title} section={section} />
      ))}
    </SidebarContent>
  );
}

/** Auto-close mobile sidebar on route change */
function MobileSidebarAutoClose() {
  const pathname = usePathname();
  const { setMobileOpen } = useMobileSidebar();

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  return null;
}

export function WikiSidebar({ sections }: { sections: NavSection[] }) {
  return (
    <>
      {/* Desktop: static sidebar */}
      <Sidebar className="sticky top-14 h-[calc(100vh-3.5rem)] border-r-0">
        <SidebarNav sections={sections} />
      </Sidebar>

      {/* Mobile: slide-out overlay */}
      <MobileSidebar>
        <SidebarNav sections={sections} />
      </MobileSidebar>

      <MobileSidebarAutoClose />
    </>
  );
}

/** Trigger button for mobile sidebar — place in content area */
export { MobileSidebarTrigger };
