import { getMatrixSnapshot } from "./compute-matrix";
import { MatrixHeatmap } from "./matrix-heatmap";

export function EntityMatrixContent() {
  const snapshot = getMatrixSnapshot();

  const canonicalCount = snapshot.rows.filter(
    (r) => r.tier === "canonical",
  ).length;
  const subEntityCount = snapshot.rows.filter(
    (r) => r.tier === "sub-entity",
  ).length;

  return (
    <div className="not-prose">
      <p className="text-muted-foreground text-sm leading-relaxed mb-3">
        Completeness matrix for {canonicalCount} canonical entity types and{" "}
        {subEntityCount} sub-entity types across{" "}
        {snapshot.dimensions.length} dimensions. Cells are auto-detected from
        the codebase. Green = complete, yellow = partial, red = missing, gray =
        N/A.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "0.5rem", marginBottom: "1rem", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontWeight: 500 }}>Overall:</span>
          <ScoreBadge score={snapshot.overallScore} />
        </div>
        {snapshot.dimensionGroups.map((group) => (
          <div key={group.id} style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
            <span className="text-muted-foreground">{group.shortLabel}:</span>
            <ScoreBadge score={snapshot.groupAverages[group.id] ?? 0} />
          </div>
        ))}
      </div>
      <MatrixHeatmap snapshot={snapshot} />
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const style: React.CSSProperties =
    score >= 80
      ? { backgroundColor: "#dcfce7", color: "#166534" }
      : score >= 40
        ? { backgroundColor: "#fef9c3", color: "#854d0e" }
        : { backgroundColor: "#fee2e2", color: "#991b1b" };

  return (
    <span
      style={{
        ...style,
        display: "inline-flex",
        alignItems: "center",
        borderRadius: "0.375rem",
        padding: "0.125rem 0.5rem",
        fontSize: "0.75rem",
        fontWeight: 500,
      }}
    >
      {score}%
    </span>
  );
}
