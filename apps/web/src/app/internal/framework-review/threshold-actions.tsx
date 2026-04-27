"use client";

import { useState } from "react";
import { useProxyAction } from "./use-proxy-action";

interface Props {
  thresholdId: string;
  currentVerdict: "approved" | "rejected" | "skip" | "edited" | null;
  currentNotes: string | null;
  fields: {
    triggerDescription: string;
    sourceQuote: string;
    sourcePageHint: string | null;
    tierLabel: string;
    riskDomainLabel: string;
  };
}

type Mode = "idle" | "rejecting" | "skipping" | "editing";

/**
 * One-click action row for a single capability threshold (QUA-710).
 *
 * Approve has no follow-up modal; reject/skip take a free-text reason;
 * edit lets the reviewer rewrite the trigger description and source
 * quote (the two fields most likely to need cleanup post-extraction).
 *
 * Posts to /api/framework-review-proxy?path=threshold/<id> with a
 * verdict + optional notes/edits. On success the page is refreshed
 * server-side via `router.refresh()` so the new verdict + threshold-
 * count flows back into the publish gate.
 */
export function ThresholdActions({
  thresholdId,
  currentVerdict,
  currentNotes,
  fields,
}: Props) {
  const { pending, error, submit } = useProxyAction();
  const [mode, setMode] = useState<Mode>("idle");
  const [notes, setNotes] = useState("");
  const [edits, setEdits] = useState({
    triggerDescription: fields.triggerDescription,
    sourceQuote: fields.sourceQuote,
  });

  function callProxy(verdict: string, body: Record<string, unknown>) {
    submit(
      `threshold/${encodeURIComponent(thresholdId)}`,
      { verdict, ...body },
      () => {
        setMode("idle");
        setNotes("");
      },
    );
  }

  return (
    <div className="border border-border/60 rounded p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {currentVerdict ? (
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded ${verdictColor(currentVerdict)}`}
            title={currentNotes ?? undefined}
          >
            {currentVerdict}
          </span>
        ) : (
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
            unreviewed
          </span>
        )}

        {mode === "idle" && (
          <>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              onClick={() => callProxy("approved", {})}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              onClick={() => setMode("editing")}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-2 py-1 rounded bg-slate-600 text-white hover:bg-slate-700 disabled:opacity-50"
              onClick={() => setMode("skipping")}
            >
              Skip
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              onClick={() => setMode("rejecting")}
            >
              Reject
            </button>
          </>
        )}
      </div>

      {(mode === "rejecting" || mode === "skipping") && (
        <div className="mt-2 space-y-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              mode === "rejecting"
                ? "Why is this threshold not a real commitment? (e.g. was a footnote, illustrative example, etc.)"
                : "Why skip? (e.g. duplicate of an earlier tier, scope outside frontier safety)"
            }
            rows={3}
            maxLength={2000}
            className="w-full text-sm rounded border border-border/60 p-2"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
              onClick={() => callProxy(mode === "rejecting" ? "rejected" : "skip", { notes })}
            >
              Confirm {mode === "rejecting" ? "reject" : "skip"}
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
              onClick={() => {
                setMode("idle");
                setNotes("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "editing" && (
        <div className="mt-2 space-y-2">
          <label className="block text-xs font-medium">
            Trigger description
            <textarea
              value={edits.triggerDescription}
              onChange={(e) =>
                setEdits((prev) => ({ ...prev, triggerDescription: e.target.value }))
              }
              rows={3}
              maxLength={5000}
              className="w-full text-sm rounded border border-border/60 p-2 mt-1"
            />
          </label>
          <label className="block text-xs font-medium">
            Source quote
            <textarea
              value={edits.sourceQuote}
              onChange={(e) =>
                setEdits((prev) => ({ ...prev, sourceQuote: e.target.value }))
              }
              rows={3}
              maxLength={5000}
              className="w-full text-sm rounded border border-border/60 p-2 mt-1"
            />
          </label>
          <label className="block text-xs font-medium">
            Reviewer notes (optional)
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="w-full text-sm rounded border border-border/60 p-2 mt-1"
              placeholder="Why was the edit needed?"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
              onClick={() =>
                callProxy("edited", {
                  notes,
                  edits: {
                    triggerDescription: edits.triggerDescription,
                    sourceQuote: edits.sourceQuote,
                  },
                })
              }
            >
              Save edits + approve
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
              onClick={() => {
                setMode("idle");
                setEdits({
                  triggerDescription: fields.triggerDescription,
                  sourceQuote: fields.sourceQuote,
                });
                setNotes("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}

function verdictColor(v: "approved" | "rejected" | "skip" | "edited"): string {
  switch (v) {
    case "approved":
      return "bg-emerald-100 text-emerald-700";
    case "rejected":
      return "bg-red-100 text-red-700";
    case "skip":
      return "bg-slate-200 text-slate-700";
    case "edited":
      return "bg-amber-100 text-amber-700";
  }
}
