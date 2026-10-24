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

Needs Docker and the Supabase CLI (2.122+). Everything below is local only; never link or push from here.

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

Two worktrees at once: change `project_id` (it names the containers) and every port in
`supabase/core/supabase/config.toml` (`[api]` 54321, `[db]` 54322 and `shadow_port` 54320, `[studio]` 54323,
`[local_smtp]` 54324) in one of them, and do not commit that change.
