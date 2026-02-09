interface DataViewProps {
  yaml: string;
}

export function DataView({ yaml }: DataViewProps) {
  return (
    <div className="ceg-data-view">
      <pre className="ceg-data-view__code">
        <code>{yaml}</code>
      </pre>
    </div>
  );
}
