"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  diffId: string;
  currentVerdict: string;
}

const VERDICTS = [
  {
    value: "confirmed_weakening",
    label: "Confirm weakening",
    color: "bg-red-600 hover:bg-red-700",
  },
  {
    value: "confirmed_strengthening",
    label: "Confirm strengthening",
    color: "bg-emerald-600 hover:bg-emerald-700",
  },
  {
    value: "false_positive",
    label: "False positive",
    color: "bg-slate-600 hover:bg-slate-700",
  },
  {
    value: "nuanced",
    label: "Nuanced",
    color: "bg-amber-600 hover:bg-amber-700",
  },
] as const;

/**
 * Per-diff verdict picker (QUA-710). Forces a free-text rationale for
 * weakening/strengthening confirmations so the audit trail captures why,
 * not just what.
 */
export function DiffActions({ diffId, currentVerdict }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pickedVerdict, setPickedVerdict] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function callProxy(verdict: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/framework-review-proxy?path=diff/${encodeURIComponent(diffId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ verdict, notes: notes || null }),
          },
        );
        if (!res.ok) {
          const errBody: { message?: string } = await res.json().catch(() => ({}));
          setError(errBody.message ?? `Request failed (${res.status})`);
          return;
        }
        setPickedVerdict(null);
        setNotes("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="border border-border/60 rounded p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
          {currentVerdict}
        </span>
        {pickedVerdict === null &&
          VERDICTS.map((v) => (
            <button
              key={v.value}
              type="button"
              disabled={pending}
              className={`text-xs px-2 py-1 rounded text-white disabled:opacity-50 ${v.color}`}
              onClick={() => setPickedVerdict(v.value)}
            >
              {v.label}
            </button>
          ))}
      </div>

      {pickedVerdict !== null && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Selected: <span className="font-mono">{pickedVerdict}</span>
          </p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Reviewer rationale (recommended for weakening/strengthening verdicts)"
            className="w-full text-sm rounded border border-border/60 p-2"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
              onClick={() => callProxy(pickedVerdict)}
            >
              Confirm
            </button>
            <button
              type="button"
              disabled={pending}
              className="text-xs px-3 py-1 rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
              onClick={() => {
                setPickedVerdict(null);
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
