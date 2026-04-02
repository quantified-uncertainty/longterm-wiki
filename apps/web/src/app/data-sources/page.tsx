import { redirect } from "next/navigation";

export default function DataSourcesPage() {
  redirect("/sources?tab=data-sources");
}
