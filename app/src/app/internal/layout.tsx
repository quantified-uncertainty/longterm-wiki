import { InternalSidebar } from "@/components/internal/InternalSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export default function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <InternalSidebar />
      <div className="flex-1 min-w-0 px-8 py-4">{children}</div>
    </SidebarProvider>
  );
}
