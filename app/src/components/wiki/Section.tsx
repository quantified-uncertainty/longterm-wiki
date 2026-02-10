import React from "react";

interface SectionProps {
  title?: string;
  children?: React.ReactNode;
}

export function Section({ title, children }: SectionProps) {
  return (
    <section className="my-6">
      {title && (
        <h3 className="text-lg font-semibold mb-3">{title}</h3>
      )}
      <div>{children}</div>
    </section>
  );
}
