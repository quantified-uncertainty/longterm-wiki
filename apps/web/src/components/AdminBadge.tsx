"use client";

import { useRouter } from "next/navigation";

export function AdminBadge() {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
        Admin
      </span>
      <button
        onClick={handleLogout}
        className="underline hover:text-foreground transition-colors"
      >
        Logout
      </button>
    </span>
  );
}
