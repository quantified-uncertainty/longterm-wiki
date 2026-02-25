import { getUpdateSchedule } from "@/data";
import { UpdatesTable } from "./updates-table";

export async function UpdateScheduleContent() {
  const { data: items } = await getUpdateSchedule();

  return (
    <>
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
    </>
  );
}
