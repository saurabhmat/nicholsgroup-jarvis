This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Local database (Supabase + pgTAP)

Needs Docker and Supabase CLI **2.122.0** (the version CI pins; other versions generate slightly different types and fail `pnpm db:types:check`). Everything below is local only; never link or push from here.

Layout (the CLI looks for `<workdir>/supabase/config.toml`, and `migrate-prod.yml` runs from `supabase/core`, so the
nesting is deliberate):

```
supabase/core/supabase/config.toml   # project_id nichols-jarvis-core
supabase/core/supabase/migrations/   # SQL migrations (supabase migration new ... --workdir supabase/core)
supabase/core/supabase/tests/        # pgTAP tests (*.sql)
supabase/core/supabase/seed.sql      # synthetic seed only
supabase/nl/                         # placeholder, deferred Nichols Law data plane
```

Commands (from the repo root):

- `pnpm db:start` / `pnpm db:stop` start and stop the local stack. `pnpm db:reset` rebuilds it from migrations and seed.
- `pnpm test:db` runs every pgTAP file in `supabase/core/supabase/tests`. It exits non-zero if the stack is not running,
  there are no tests, or any test fails.
- Analytics and vector services are disabled in `config.toml` (they fail health checks locally and are not needed).

- `pnpm db:types` regenerates `packages/core/src/db/types.ts` (exported as `Database` from `@nichols/core/db`) from the
  local stack. Run `pnpm db:reset && pnpm db:types` **after every migration** and commit the result. It writes via a
  staged file, so a failure leaves the old file intact. `pnpm db:types:check` compares the committed file with the
  running local DB, so run it right after a reset (CI runs it after `pnpm test:db`, which resets).

Notes:

- `pnpm test:db` runs `supabase db reset --local` first so tests always see this branch's migrations. Pass
  `--no-reset` (`pnpm test:db --no-reset`) to skip it. It never starts the stack for you.
- `supabase start` publishes ports on all interfaces, so Postgres, Studio and Mailpit are reachable from your LAN.
  Set `"ip": "127.0.0.1"` in Docker's `daemon.json` or use a firewall.
- Analytics is disabled, so there is no local `supabase logs`.
- Local sign-ups are off; tests create users through the admin API.

### Seed data (synthetic only)

`supabase/core/supabase/seed.sql` is **generated** by `supabase/core/seed/` and committed; `supabase db reset --local`
applies it through `[db.seed]` in `config.toml`. Do not edit it by hand.

**Local only.** Never apply this seed with `--include-seed`, `--linked` or `--db-url`. As a backstop, its first
statements set `standard_conforming_strings = on` and abort (`synthetic seed refuses: non-synthetic users present`)
when the target database has any auth user whose email is not on `example.test`.

- `pnpm db:seed` regenerates it, `pnpm db:seed:check` fails if it is out of date (`pnpm test` and `pnpm test:db` check
  this too). `pnpm db:reset` regenerates and then resets the **local** DB.
- Deterministic: a fixed seed (`SEED` in `data.mjs`) drives a SHA-256 counter RNG (`rng.mjs`); timestamps use
  `SEED_EPOCH`, never `now()`. The same seed always gives a byte-identical file. Each section and each entity has its
  own RNG stream (label paths are JSON-encoded, so they cannot collide), so adding one never changes another's ids.
- `data.mjs` defines the lanes (PKG, APK, PKI, NC, NL, P; only PKG enabled) and five personas (owner,
  admin_technical, finance_operator, viewer, outsider) with "Synthetic ..." labels, `@example.test` emails and their
  intended lane memberships. `buildSeedData(seed)` adds a deterministic `id` to each lane (`lane:<code>`) and persona
  (`persona:<key>`).
- Seeded today: the personas as Supabase Auth users (section `auth-personas`). They have **no password** and an
  undeliverable reserved domain; local tests get sessions through the admin API or JWT claims in pgTAP.
- The generator lexes every statement and refuses dollar quoting, `E''` and `U&''` strings (every literal comes from
  `lit()`), non-deterministic SQL (`now()`, `random()`, `gen_random_uuid()`, `gen_random_bytes()`, `'now'::...`,
  `'today'`, `current_timestamp`, ...) and descriptions with control characters. It then runs the guard
  (`guard.mjs`), which rejects: emails outside `example.test`; non-reserved domains in literals; capitalized words in
  literals, comments or quoted identifiers that are not lane names or persona labels; SSN-like numbers or 9+ digit
  runs in literals; known real names. **The guard is a heuristic**: it does not catch lower-case names or names built
  with `chr()` or `||`, so new sections still need review.

**Adding a seed section (T-010, T-011, T-012, ...).** Create `supabase/core/seed/sections/<id>.mjs` exporting
`{ id, description, build(ctx) }`, where `build` returns an array of SQL statements (each ending in `;`). Use
`ctx.data` (lanes and personas with ids, epoch), `ctx.rng` (this section's stream: `uuid()`, `int()`, `pick()`,
`derive(label)`) and the `lit` / `json` / `values` helpers from `sql.mjs`; never interpolate raw strings. Register
it in `sections/index.mjs` after the sections it references, run `pnpm db:seed`, and commit `seed.sql`. Rules:

- **Set every column that defaults to `now()` or a random value** (`created_at`, `updated_at`, `id`, ...) explicitly
  from `ctx.data.epoch` / `ctx.rng`. Column defaults are invisible to the generator: leaving one out keeps `seed.sql`
  byte-identical but makes the database differ between resets.
- **Cross-section references:** an id that another section needs lives in `data.mjs` under a per-entity label (like
  `lane:<code>` and `persona:<key>`), never in a section's own `ctx.rng`. Otherwise reference rows by natural key in
  SQL, e.g. `(select id from core.lanes where code = 'PKG')`.
- A section's tables must already exist in a migration, because seeds run after migrations.

Example for T-010:

```js
import { values } from "../sql.mjs";
export default {
  id: "lanes",
  description: "lane registry (only PKG enabled)",
  build: (ctx) =>
    ctx.data.lanes.map((l) =>
      `insert into core.lanes (code, name, data_plane, enabled) values (${values(l.code, l.name, l.dataPlane, l.enabled)});`),
};
```

New synthetic words (for example a fake vendor name) must be added to `ALLOWED_NAME_WORDS` in `data.mjs` in the same
reviewed change.

Two worktrees at once: change `project_id` (it names the containers) and every port in
`supabase/core/supabase/config.toml` (`[api]` 54321, `[db]` 54322 and `shadow_port` 54320, `[studio]` 54323,
`[local_smtp]` 54324) in one of them, and do not commit that change.

To keep a per-worktree port change out of `git status`, run
`git update-index --skip-worktree supabase/core/supabase/config.toml` (undo with `--no-skip-worktree`).
