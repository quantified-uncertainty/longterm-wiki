import React from "react";
import { getTypedEntityById } from "@/data";
import { cn } from "@lib/utils";

interface ModelsListProps {
  entityId: string;
  className?: string;
  "client:load"?: boolean;
}

export function ModelsList({ entityId, className }: ModelsListProps) {
  const entity = getTypedEntityById(entityId);
  if (!entity) return null;

  // Find related entries that are models
  const modelEntries = entity.relatedEntries?.filter(
    (entry) => entry.type === "model" || entry.type === "foundation-model"
  ) || [];

  if (modelEntries.length === 0) return null;

  // Resolve model titles and build list
  const models = modelEntries.map((entry) => {
    const modelEntity = getTypedEntityById(entry.id);
    return {
      id: entry.id,
      title: modelEntity?.title || entry.id.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      description: modelEntity?.description,
      relationship: entry.relationship,
    };
  });

  return (
    <div className={cn("my-6 rounded-lg border bg-card p-5", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Related Models
      </h3>
      <ul className="space-y-2">
        {models.map((model) => (
          <li key={model.id} className="text-sm">
            <span className="font-medium">{model.title}</span>
            {model.relationship && (
              <span className="text-muted-foreground"> — {model.relationship}</span>
            )}
            {model.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {model.description}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
