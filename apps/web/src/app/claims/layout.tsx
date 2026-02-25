import { SidebarProvider } from "@/components/ui/sidebar";
import {
  WikiSidebar,
  MobileSidebarTrigger,
} from "@/components/wiki/WikiSidebar";
import { getClaimsNav } from "./components/claims-nav";

export default async function ClaimsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sections = await getClaimsNav();

  return (
    <SidebarProvider>
      <div className="flex w-full">
        <WikiSidebar sections={sections} />
        <div className="flex-1 min-w-0 max-w-[90rem] mx-auto px-6 py-8">
          <MobileSidebarTrigger className="mb-4 md:hidden" />
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}
