---
name: Dev server port convention
description: Always use slot-specific port from .env DEV_PORT, never guess or use 3001
type: feedback
---

Always check `.env` for `DEV_PORT` and `.claude/rules/environment-setup.md` before starting a dev server. Port 3001 belongs to the user's main dev server — never use it from agent slots. Convention is `3010 + slot number` (a6 = 3016).

**Why:** User corrected after agent started dev servers on wrong ports (3001, then 3099). The port info was in `.env` and documented in environment-setup.md but was not checked.

**How to apply:** Before any `pnpm dev` or `next dev`, read `.env` for `DEV_PORT`. Use `DEV_PORT=<port> pnpm dev` or `npx next dev -p <port>`.
