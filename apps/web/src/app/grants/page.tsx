import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Grants",
  description:
    "Grant data is temporarily unavailable while records migrate to PostgreSQL.",
};

export default function GrantsPage() {
  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Grants
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of individual grant disbursements tracked in the knowledge
          base.
        </p>
      </div>

      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        Grant data is temporarily unavailable while records migrate to PostgreSQL.
      </div>
    </div>
  );
}
