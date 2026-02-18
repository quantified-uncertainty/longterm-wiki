import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { getInternalNav } from "@/lib/wiki-nav";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sections = getInternalNav();
  return (
    <SidebarProvider>
      <WikiSidebar sections={sections} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="px-8 py-4">{children}</div>
      </div>
    </SidebarProvider>
  );
}
