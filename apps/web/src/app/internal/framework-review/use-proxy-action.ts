"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Shared submit-and-refresh helper for the framework-review action panels.
 *
 * Three client islands (threshold-actions, diff-actions, publish-button)
 * share an identical shape: POST to /api/framework-review-proxy with a
 * path + JSON body, surface server errors, then router.refresh() on
 * success. This hook centralizes the fetch + error parsing + transition
 * wrapping so each island only writes its own UI.
 *
 * `error` is null after a successful submit — clearing it on retry is
 * the consumer's responsibility (just call submit() again).
 */
export function useProxyAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(
    path: string,
    body: Record<string, unknown>,
    onSuccess?: () => void,
  ) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/framework-review-proxy?path=${encodeURIComponent(path)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const errBody: { message?: string } = await res
            .json()
            .catch(() => ({}));
          setError(errBody.message ?? `Request failed (${res.status})`);
          return;
        }
        onSuccess?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return { pending, error, submit };
}
