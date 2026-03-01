"use client";

import { signOut } from "next-auth/react";

export function AdminBadge() {
  async function handleLogout() {
    await signOut({ callbackUrl: "/" });
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
