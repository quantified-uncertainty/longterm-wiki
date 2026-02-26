import { SidebarProvider } from "@/components/ui/sidebar";
import { ClaimsSidebar, MobileSidebarTrigger } from "./components/claims-sidebar";
import { getClaimsNav, getClaimsEntities } from "./components/claims-nav";

export default async function ClaimsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sections, entities] = await Promise.all([
    getClaimsNav(),
    getClaimsEntities(),
  ]);

  return (
    <SidebarProvider>
      <div className="flex w-full">
        <ClaimsSidebar sections={sections} entities={entities} />
        <div className="flex-1 min-w-0 max-w-[90rem] mx-auto px-6 py-8">
          <MobileSidebarTrigger className="mb-4 md:hidden" />
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}
