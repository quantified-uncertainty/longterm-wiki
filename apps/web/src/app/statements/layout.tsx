import { SidebarProvider } from "@/components/ui/sidebar";
import {
  StatementsSidebar,
  MobileSidebarTrigger,
} from "./components/statements-sidebar";
import {
  getStatementsNav,
  getStatementCategories,
  getStatementEntities,
} from "./components/statements-nav";

export default async function StatementsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sections, categories, entities] = await Promise.all([
    getStatementsNav(),
    getStatementCategories(),
    getStatementEntities(),
  ]);

  return (
    <SidebarProvider>
      <div className="flex w-full">
        <StatementsSidebar
          sections={sections}
          categories={categories}
          entities={entities}
        />
        <div className="flex-1 min-w-0 max-w-[90rem] mx-auto px-6 py-8">
          <MobileSidebarTrigger className="mb-4 md:hidden" />
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}
