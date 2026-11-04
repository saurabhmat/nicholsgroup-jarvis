# Running the browser tests (Playwright) on the dev machine

Chromium needs some system libraries that are not installed on the dev machine, and agents have no `sudo`.

## Preferred (needs your password once)
```bash
cd apps/web && sudo npx playwright install-deps chromium
pnpm --filter @nichols/web test:e2e
```

## Without sudo (what agents use, Nov 4, 2026)
The libraries are unpacked from the Ubuntu 24.04 packages into `~/.local/share/pw-libs` (no system change; delete the folder to undo):
```bash
D=~/.local/share/pw-libs; mkdir -p $D/debs && cd $D/debs
apt-get download libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 libxrender1 libxi6
for f in *.deb; do dpkg-deb -x "$f" $D/root; done
```
Then run the tests with the folder on the library path:
```bash
cd apps/web
LD_LIBRARY_PATH=~/.local/share/pw-libs/root/usr/lib/x86_64-linux-gnu pnpm test:e2e
```
Needs the local Supabase stack (`pnpm db:start`). Global setup resets the local database. Never point these tests at a hosted project.
