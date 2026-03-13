/**
 * AI Models table section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { getEntityHref } from "@/data/entity-nav";
import { formatCompactNumber } from "@/lib/format-compact";
import { formatKBDate } from "@/components/wiki/kb/format";

interface AiModelEntry {
  id: string;
  title: string;
  entityType: string;
  numericId?: string;
  releaseDate?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  contextWindow?: number | null;
}

export function AiModelsSection({
  models,
}: {
  models: AiModelEntry[];
}) {
  if (models.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold tracking-tight">
          AI Models ({models.length})
        </h2>
        <Link
          href={`/ai-models`}
          className="text-xs text-primary hover:underline"
        >
          View all models &rarr;
        </Link>
      </div>
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Model</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Released</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Pricing (in/out)</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Context</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {models.map((model) => {
              const href = model.numericId ? `/wiki/${model.numericId}` : getEntityHref(model.id, model.entityType);
              return (
                <tr key={model.id} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <Link href={href} className="font-medium text-foreground hover:text-primary transition-colors">
                      {model.title}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                    {model.releaseDate ? formatKBDate(model.releaseDate) : ""}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {model.inputPrice != null && model.outputPrice != null
                      ? `$${model.inputPrice} / $${model.outputPrice}`
                      : ""}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                    {model.contextWindow != null
                      ? `${formatCompactNumber(model.contextWindow)} tokens`
                      : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
