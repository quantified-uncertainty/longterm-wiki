# Wiki Server (Postgres + Hono)

Lightweight API server backed by Postgres, providing:

- **Atomic E ID generation** — eliminates merge conflicts when parallel branches assign entity IDs
- **Edit logs** — append-only edit history that doesn't conflict across branches

## Quick Start

```bash
# 1. Start Postgres
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Generate and run migrations
pnpm db:generate
pnpm db:migrate

# 4. Seed from existing YAML/MDX data
pnpm db:seed

# 5. Start the server (port 3002)
pnpm server
```

## API Endpoints

### Entity IDs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ids/next` | Allocate next E ID for a slug (idempotent) |
| `GET` | `/api/ids` | List all registered IDs |
| `GET` | `/api/ids/:slug` | Look up numeric ID by slug |

**Allocate an ID:**
```bash
curl -X POST http://localhost:3002/api/ids/next \
  -H 'Content-Type: application/json' \
  -d '{"slug": "new-entity", "entityType": "concept", "title": "New Entity"}'
# → {"numericId": "E628", "slug": "new-entity", "alreadyExisted": false}
```

### Edit Logs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/edit-logs` | Append an edit-log entry |
| `GET` | `/api/edit-logs/:pageId` | Get history for a page |
| `GET` | `/api/edit-logs` | List recent entries across all pages |

**Log an edit:**
```bash
curl -X POST http://localhost:3002/api/edit-logs \
  -H 'Content-Type: application/json' \
  -d '{"pageId": "agi-timeline", "tool": "crux-improve", "agency": "ai-directed"}'
```

## Migration Strategy

This is Phase 1 of a gradual migration from git-managed YAML to Postgres:

1. **Phase 1 (this PR):** Postgres for ID generation + edit logs. YAML files remain the source of truth for content. Dual-write during transition.
2. **Phase 2:** Entity metadata (what's in `data/entities/*.yaml`) moves to Postgres. YAML becomes a read cache / export format.
3. **Phase 3:** Facts, resources, and relationship data migrate. MDX content stays on disk.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://wiki:wiki_dev@localhost:5433/longterm_wiki` | Postgres connection string |
| `PORT` | `3002` | Server port |

## Development

```bash
pnpm server          # Start with hot-reload (tsx watch)
pnpm db:studio       # Open Drizzle Studio (DB browser)
pnpm db:generate     # Generate migration from schema changes
pnpm db:migrate      # Apply pending migrations
pnpm db:seed         # Re-seed from YAML/MDX (idempotent)
```
