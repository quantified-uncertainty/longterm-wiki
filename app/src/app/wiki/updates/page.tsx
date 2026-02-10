import { getUpdateSchedule } from "@/data";
import { UpdatesTable } from "./updates-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Update Schedule | Longterm Wiki",
  description: "Pages ranked by update priority based on staleness and importance.",
};

export default function UpdatesPage() {
  const items = getUpdateSchedule();

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Update Schedule</h1>
        <p className="text-muted-foreground text-sm">
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
      </div>
      <UpdatesTable data={items} />
    </div>
  );
}
