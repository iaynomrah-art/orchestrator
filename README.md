# Express Template

> Minimal Express API using pnpm and Supabase (development scaffold).

## Quick Start

Prerequisites:

- Node.js (LTS) installed
- pnpm (optional) — install with `npm i -g pnpm`
- Supabase project credentials (URL and API key)

Install dependencies:

```
pnpm install
```

Start the app:

```
node index.js
# or, if a start script exists
pnpm start
```

Environment variables:

- `PORT` — port to run the server (default: `3000`)
- `PUBLIC_SUPABASE_URL` — Supabase project API URL
- `SUPABASE_SERVICE_SECRET_KEY` — Supabase project service secret key

What it contains:

- `index.js` — app entry (initializes Supabase, registers middleware, starts server)
- `config/` — Supabase config
- `controller/` — route controllers
- `middleware/` — error handler and validators
- `model/`, `routes/`, `public/` — app structure for models, routes and static

API

- `GET /` — basic health / greeting endpoint

Notes

- The project uses ES modules (import/export). Run with a Node version that supports them or via a package manager script that sets `node --experimental-modules` if needed.

If you want, I can add a `start`/`dev` script to `package.json` and a short contributors section.
