import type { DataSource, ApiErrorReason } from "@lib/wiki-server";

interface DataSourceBannerProps {
  source: DataSource;
  apiError?: ApiErrorReason;
}

export function DataSourceBanner({ source, apiError }: DataSourceBannerProps) {
  if (source === "api") {
    return (
      <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-4">
        Live data from wiki-server
      </p>
    );
  }

  if (!apiError || apiError.type === "not-configured") {
    return (
      <div className="border-l-4 border-blue-400 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 mb-4 not-prose">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          Using local data. Set{" "}
          <code className="text-xs bg-blue-100 dark:bg-blue-900/50 px-1 py-0.5 rounded">
            LONGTERMWIKI_SERVER_URL
          </code>{" "}
          to enable live data from wiki-server.
        </p>
      </div>
    );
  }

  if (apiError.type === "connection-error") {
    return (
      <div className="border-l-4 border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 mb-4 not-prose">
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Could not reach wiki-server &mdash; showing local data.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
          Error: {apiError.message}
        </p>
      </div>
    );
  }

  // server-error
  return (
    <div className="border-l-4 border-red-400 bg-red-50 dark:bg-red-950/30 px-4 py-3 mb-4 not-prose">
      <p className="text-sm text-red-800 dark:text-red-200">
        Wiki-server returned HTTP {apiError.status} ({apiError.statusText})
        &mdash; showing local data.
      </p>
    </div>
  );
}
