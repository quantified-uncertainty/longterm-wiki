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

If you reorder a Dockerfile so it `COPY crux/`s before `pnpm install`, the unguarded form of `postinstall` will work — but the smoke workflow (see "CI prevention" below) is the only thing keeping that ordering honest, so prefer to keep the guard regardless. Every reorder is one git operation away from being undone.

`Dockerfile.worker` is exempt: it uses an isolated `docker/worker/package.json`, so the root `postinstall` never fires inside it. The worker has its own dependency-coverage protection — `crux/validate/validate-workspace-dep-coverage.ts` (gate-enforced) ensures every `file:` workspace dep declared in `docker/worker/package.json` has a matching `COPY` line in `Dockerfile.worker`. That validator does not protect the three sub-app Dockerfiles, and this trap doc does not cover the worker. Each is the only protection for its own image.

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

`.github/workflows/sub-app-docker-smoke.yml` builds the discord-bot Dockerfile on any PR that touches root `package.json`, `pnpm-lock.yaml`, any sub-app Dockerfile (matched as `apps/*/Dockerfile`, so newly-added sub-apps are covered too), or `apps/discord-bot/package.json`.

Discord-bot is chosen because it has the fewest workspace dependencies in its install filter (no `packages/*` deps, unlike wiki-server) — so its install layer is the fastest to build of the three. Its produced image is actually larger than groundskeeper's because it bakes wiki content for the `/ask` command, but image size doesn't affect what runs during the install layer, which is the only thing this smoke test exercises.

If you add a new sub-app Dockerfile, the workflow already runs against it via the `apps/*/Dockerfile` glob, but the build itself still targets discord-bot. That's intentional: every sub-app shares the same install-layer surface for the QUA-1053 failure class, and discord-bot is the cheapest representative.

## Audit rule

Any lifecycle script in the **root** `package.json` (`preinstall`, `install`, `postinstall`, `prepare`) must not crash when `crux/`, `apps/`, `packages/`, or any other source directory is missing. In practice that means one of:

1. The script *only references files that exist in the repo root before any sub-app docker COPY happens* — i.e. the root manifest itself, or files baked into the layer that runs the script.
2. The script *executes* a path under `crux/` etc., so it must be guarded with POSIX `if [ -f ... ]; then ...; fi` to be a clean no-op when the file is missing.
3. The script *only references* (without executing) a path — e.g. `git config merge.foo.driver 'node crux/git/merge.mjs'` registers a path as a config string but does not invoke it. These are safe even though they textually reference `crux/`. The current root `prepare` is in this category.

The same trap does *not* apply to scripts in `apps/<name>/package.json` — those only fire when their own package is being installed, which happens after the relevant `COPY apps/<name>/` lines.

## Related

- QUA-1053 — original regression (PR #4838)
- QUA-1081 — postmortem and prevention (this doc, the smoke workflow)
- Deploy chain that surfaced and resolved it:
  - PR #4840 — initial release (failed: wiki-server / discord-bot / groundskeeper docker builds crashed in postinstall)
  - PR #4846 — first hotfix (broken: replaced try/catch with `accessSync` but kept the `&& cmd` chain — same bug)
  - PR #4848 — second release attempt (still hit the broken postinstall via the broken hotfix)
  - PR #4849 — working hotfix (replaced the entire chain with `if [ -f ... ]; then ...; fi`)
  - PR #4850 — clean release after the working hotfix
