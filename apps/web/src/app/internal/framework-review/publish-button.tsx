"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProxyAction } from "./use-proxy-action";

interface Props {
  versionId: string;
  /** Disabled when not every threshold is reviewed. */
  ready: boolean;
  thresholdsReviewed: number;
  thresholdCount: number;
}

/**
 * Publish-or-reject action for one pending framework version (QUA-710).
 *
 * The "Publish" path is gated client-side on the `ready` prop; the
 * server-side check in `/api/framework-review/version/:id/publish` is
 * authoritative — the disabled state is just UX (so reviewers can see
 * why the button is dim before clicking it).
 *
 * The "Reject" path is always available and prompts for a reason —
 * rejecting a whole version is a destructive call so we want a paper
 * trail.
 */
export function PublishButton({
  versionId,
  ready,
  thresholdsReviewed,
  thresholdCount,
}: Props) {
  const router = useRouter();
  const { pending, error, submit } = useProxyAction();
  const [mode, setMode] = useState<"idle" | "rejecting">("idle");
  const [notes, setNotes] = useState("");

  function publish(verdict: "published" | "rejected") {
    submit(
      `version/${encodeURIComponent(versionId)}/publish`,
      { verdict, notes: notes || null },
      () => {
        setMode("idle");
        setNotes("");
        // Navigate back to the queue overview after a successful action.
        // useProxyAction has already called router.refresh().
        router.push("/wiki/E2505");
      },
    );
  }

  if (mode === "rejecting") {
    return (
      <div className="space-y-2 border border-red-300 rounded p-3 bg-red-50">
        <p className="text-sm font-medium text-red-700">
          Reject this whole version? This marks the version as not-publishable —
          its thresholds will not appear on the public site.
        </p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Reason (e.g. wrong document, draft never published, paywalled)"
          className="w-full text-sm rounded border border-red-300 p-2 bg-white"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            className="text-sm px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            onClick={() => publish("rejected")}
          >
            Confirm reject
          </button>
          <button
            type="button"
            disabled={pending}
            className="text-sm px-3 py-1 rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
            onClick={() => {
              setMode("idle");
              setNotes("");
            }}
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={!ready || pending}
        className="text-sm px-4 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        onClick={() => publish("published")}
      >
        Publish version
      </button>
      <button
        type="button"
        disabled={pending}
        className="text-sm px-4 py-2 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
        onClick={() => setMode("rejecting")}
      >
        Reject version
      </button>
      <p className="text-xs text-muted-foreground">
        {thresholdsReviewed}/{thresholdCount} thresholds reviewed
        {!ready && (thresholdCount > 0 ? " — review remaining first" : " — extraction has zero thresholds; reject or re-extract")}
      </p>
      {error && <p className="text-xs text-red-700 w-full">{error}</p>}
    </div>
  );
}
