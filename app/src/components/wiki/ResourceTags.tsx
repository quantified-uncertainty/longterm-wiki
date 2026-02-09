import React from "react";

const tagColors: Record<string, { bg: string; text: string }> = {
  alignment: { bg: "rgba(156, 39, 176, 0.12)", text: "#7b1fa2" },
  safety: { bg: "rgba(46, 125, 50, 0.12)", text: "#2e7d32" },
  governance: { bg: "rgba(25, 118, 210, 0.12)", text: "#1565c0" },
  capabilities: { bg: "rgba(255, 152, 0, 0.12)", text: "#e65100" },
  "x-risk": { bg: "rgba(211, 47, 47, 0.12)", text: "#c62828" },
  interpretability: { bg: "rgba(0, 150, 136, 0.12)", text: "#00796b" },
  evaluation: { bg: "rgba(103, 58, 183, 0.12)", text: "#512da8" },
  training: { bg: "rgba(63, 81, 181, 0.12)", text: "#303f9f" },
  economic: { bg: "rgba(121, 85, 72, 0.12)", text: "#5d4037" },
  biosecurity: { bg: "rgba(233, 30, 99, 0.12)", text: "#c2185b" },
};

function getTagColor(tag: string) {
  return tagColors[tag] || { bg: "rgba(158, 158, 158, 0.12)", text: "#616161" };
}

export function ResourceTags({
  tags,
  limit = 3,
  size = "sm",
  className = "",
}: {
  tags: string[];
  limit?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const displayTags = tags.slice(0, limit);
  const remaining = tags.length - limit;
  const style = size === "sm"
    ? { fontSize: "9px", padding: "1px 4px" }
    : { fontSize: "10px", padding: "2px 6px" };

  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: "3px", flexWrap: "wrap" }}>
      {displayTags.map((tag) => {
        const colors = getTagColor(tag);
        return (
          <span key={tag} style={{ ...style, borderRadius: "3px", backgroundColor: colors.bg, color: colors.text, fontWeight: 500, whiteSpace: "nowrap" }}>
            {tag}
          </span>
        );
      })}
      {remaining > 0 && (
        <span style={{ fontSize: style.fontSize, color: "#9ca3af" }} title={tags.slice(limit).join(", ")}>
          +{remaining}
        </span>
      )}
    </span>
  );
}

export default ResourceTags;
