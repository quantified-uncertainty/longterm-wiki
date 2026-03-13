export function EducationSection({ education }: { education: string }) {
  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">Education</h2>
      <div className="border border-border/60 rounded-xl bg-card px-5 py-3">
        <p className="text-sm">{education}</p>
      </div>
    </section>
  );
}
