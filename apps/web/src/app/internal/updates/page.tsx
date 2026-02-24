import { getUpdateSchedule } from "@/data";
import { UpdatesTable } from "./updates-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Update Schedule | Longterm Wiki Internal",
  description: "Pages ranked by update priority based on staleness and importance.",
};

export default async function UpdatesPage() {
  const { data: items } = await getUpdateSchedule();

  return (
    <article className="prose max-w-none">
      <h1>Update Schedule</h1>
      <p className="text-muted-foreground">
        Pages ranked by update priority. Priority is calculated as staleness
        (days since edit / update frequency) weighted by importance.
        {items.length > 0 && (
          <>
            {" "}
            <span className="font-medium text-foreground">
              {items.filter((i) => i.daysUntilDue < 0).length}
            </span>{" "}
            pages are overdue.
          </>
        )}
      </p>
      <UpdatesTable data={items} />
    </article>
  );
}
