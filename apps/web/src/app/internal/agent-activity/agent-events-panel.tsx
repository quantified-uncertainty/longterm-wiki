"use client";

import { useState } from "react";

interface AgentEvent {
  id: number;
  agentId: number;
  eventType: string;
  message: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  registered: "bg-green-500/15 text-green-600",
  checklist_check: "bg-cyan-500/15 text-cyan-600",
  status_update: "bg-yellow-500/15 text-yellow-600",
  error: "bg-red-500/15 text-red-500",
  note: "bg-muted text-muted-foreground",
  completed: "bg-emerald-500/15 text-emerald-500",
};

function EventTypeBadge({ type }: { type: string }) {
  const style = EVENT_TYPE_STYLES[type] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${style}`}
    >
      {type}
    </span>
  );
}

export function AgentEventsPanel({ agentId }: { agentId: number }) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadEvents() {
    if (events !== null) {
      setExpanded(!expanded);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent-session-events?agentId=${agentId}&limit=100`);
      if (!res.ok) {
        setError("Failed to load events");
        return;
      }
      const data: { events: AgentEvent[] } = await res.json();
      setEvents(data.events);
      setExpanded(true);
    } catch {
      setError("Failed to load events");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={loadEvents}
        className="text-xs text-blue-600 hover:underline"
        disabled={loading}
      >
        {loading
          ? "Loading..."
          : expanded
            ? "Hide events"
            : "Show events"}
      </button>

      {error && (
        <p className="text-xs text-red-500 mt-1">{error}</p>
      )}

      {expanded && events && (
        <div className="mt-2 space-y-1 max-h-[300px] overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events recorded.</p>
          ) : (
            // Show chronological (API returns newest first)
            [...events].reverse().map((e) => {
              const ts = new Date(e.timestamp);
              const timeStr = ts.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              const dateStr = ts.toLocaleDateString();

              return (
                <div
                  key={e.id}
                  className="flex items-start gap-2 text-xs py-1 border-b border-border/30 last:border-0"
                >
                  <span className="text-muted-foreground/60 tabular-nums whitespace-nowrap shrink-0">
                    {dateStr} {timeStr}
                  </span>
                  <EventTypeBadge type={e.eventType} />
                  <span className="text-foreground/80 break-words min-w-0">
                    {e.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
