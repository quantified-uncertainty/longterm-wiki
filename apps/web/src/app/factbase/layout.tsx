import {
  WikiSidebar,
  MobileSidebarTrigger,
} from "@/components/wiki/WikiSidebar";
import { getFactBaseNav } from "@/lib/wiki-nav";
import { SidebarProvider } from "@/components/ui/sidebar";

export default function FactBaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sections = getFactBaseNav();
  return (
    <SidebarProvider>
      <WikiSidebar sections={sections} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="max-w-[65rem] mx-auto px-8 py-4">{children}</div>
      </div>
    </SidebarProvider>
  );
}
