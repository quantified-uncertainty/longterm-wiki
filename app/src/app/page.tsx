import Link from "next/link";
import { getExploreItems } from "@/data";

export default function Home() {
  const items = getExploreItems().filter(
    (item) => !item.type.startsWith("ai-transition-model")
  );
  const topItems = items
    .sort((a, b) => ((b.importance || 0) * 2 + (b.quality || 0)) - ((a.importance || 0) * 2 + (a.quality || 0)))
    .slice(0, 8);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-3">Longterm Wiki</h1>
        <p className="text-lg text-muted-foreground max-w-2xl">
          An AI safety knowledge base with {items.length} entities covering risks,
          approaches, projects, organizations, and key people.
        </p>
        <Link
          href="/wiki"
          className="inline-block mt-4 px-4 py-2 bg-foreground text-background rounded-md text-sm font-medium no-underline hover:opacity-90 transition-opacity"
        >
          Explore all entities
        </Link>
      </div>

      <h2 className="text-xl font-semibold mb-4">Top entities</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {topItems.map((item) => (
          <Link
            key={item.id}
            href={`/wiki/${item.numericId}`}
            className="group block p-4 border border-border rounded-lg hover:border-foreground/30 hover:shadow-sm transition-all no-underline bg-card"
          >
            <span className="text-xs text-muted-foreground">{item.type}</span>
            <h3 className="text-sm font-semibold text-foreground mt-1">
              {item.title}
            </h3>
            {item.description && (
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {item.description.length > 100 ? item.description.slice(0, 97) + "..." : item.description}
              </p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
