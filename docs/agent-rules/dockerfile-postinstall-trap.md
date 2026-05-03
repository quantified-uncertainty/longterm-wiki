# Sub-app Dockerfile postinstall trap

Read this before adding a new sub-app `Dockerfile` (e.g. `apps/<name>/Dockerfile`), changing the `postinstall` script in the root `package.json`, or modifying the `COPY` order in any of the existing sub-app Dockerfiles (`apps/wiki-server`, `apps/discord-bot`, `apps/groundskeeper`).

## The trap

The three sub-app Dockerfiles all follow the same shape:

```dockerfile
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/<name>/package.json ./apps/<name>/
RUN pnpm install --frozen-lockfile --filter <name>
# ... later: COPY apps/<name>/ ./apps/<name>/, COPY crux/ ./crux/, etc.
```

`pnpm install` runs the **root** `package.json`'s `postinstall` script during this layer — *before* the rest of the repo (including `crux/`) has been copied. If `postinstall` references files that have not been copied yet, the docker build crashes with `Cannot find module '/repo/<file>'` and the deploy fails.

`Dockerfile.worker` is exempt: it uses an isolated `docker/worker/package.json`, so the root `postinstall` never fires inside it. The trap only hits the three full-monorepo sub-app images.

## The fix

The root `postinstall` must short-circuit if the file it depends on is missing. **Use POSIX shell, not `node -e`:**

```jsonc
// package.json
"postinstall": "if [ -f crux/build.mjs ]; then node crux/build.mjs; fi"
```

This exits 0 cleanly when `crux/build.mjs` is absent (the docker install layer) and runs the build when it's present (local dev, CI, full clones).

### Why not `node -e ... && cmd`?

This is the pattern QUA-1053 introduced and QUA-1081 (the postmortem) replaced:

```jsonc
// BROKEN — do not use this shape
"postinstall": "node -e \"try{require.resolve('esbuild')}catch{process.exit(0)}\" && node crux/build.mjs"
```

It is logically broken in both branches:

- If `esbuild` resolves: try succeeds → script ends → exit 0 → `&&` runs `node crux/build.mjs`. Crashes if `crux/build.mjs` isn't on disk.
- If `esbuild` is missing: catch fires → `process.exit(0)` → exit 0 → `&&` *still* runs `node crux/build.mjs`. The "guard" never short-circuits.

A non-zero exit in the guard would be required to short-circuit `&&`, but `process.exit(0)` (and a successful try block) both exit 0. Either use POSIX `if`/`||` to actually skip the body, or do the file existence check inside the script you're conditionally running. The first hotfix attempt (PR #4846) replaced the `try/catch` with `accessSync` but kept the `&& cmd` chain — same bug, no fix. PR #4849 was the working fix.

## CI prevention

`.github/workflows/sub-app-docker-smoke.yml` builds the discord-bot Dockerfile on any PR that touches root `package.json`, `pnpm-lock.yaml`, or any of the three sub-app Dockerfiles. Discord-bot is the cheapest of the three (smallest image, fewest workspace deps) but it exercises the same failure mode — root `postinstall` fires during its install layer.

If you add a new sub-app Dockerfile or change which file is "smallest," update the workflow accordingly.

## Audit rule

Any script in the **root** `package.json` (especially lifecycle hooks: `preinstall`, `install`, `postinstall`, `prepare`) must either:

1. Reference only files that exist in the repo root before any sub-app docker COPY happens (i.e. the root manifest itself), **or**
2. Guard with POSIX `if [ -f ... ]; then ...; fi` so the docker install layer is a clean no-op.

The same trap does *not* apply to scripts in `apps/<name>/package.json` — those only fire when their own package is being installed, which happens after the relevant `COPY apps/<name>/` lines.

## Related

- QUA-1053 — original regression (PR #4838)
- QUA-1081 — postmortem and prevention (this doc, the smoke workflow)
- Deploy chain that surfaced it: PRs #4840, #4846, #4848, #4849, #4850
