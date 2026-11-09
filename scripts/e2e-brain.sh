#!/usr/bin/env bash
# H-042: one command for the onboarding, brain-interview and shell Playwright specs (pnpm e2e:brain).
#
# The e2e server refuses to start while apps/web has a .env file (it must run against the LOCAL Supabase stack only),
# so this takes apps/web/.env.local out of apps/web for the run and ALWAYS puts it back (trap on exit, Ctrl-C included).
# scripts/e2e-env-guard.sh does the move and restore (tested by scripts/e2e-env-guard.test.mjs): a regular file is moved
# to ~/.cache/jarvis-e2e/<hash of this checkout's path>/file; a SYMLINK (here: -> ../../.env.local) is removed and
# recreated with the same target. Contents are never read, copied or printed. If a run was killed hard (kill -9, power
# loss), the next run restores first. The backup is deleted only after the restore succeeded.
#
# WARNING: the run RESETS THE LOCAL DATABASE (Playwright global setup): local connections, Vault tokens and brain pages
# are wiped. Never touches a linked or production project.
#
# Defaults: E2E_SERVER=build (next build + next start; faster than next dev on a slow filesystem). Override with
# E2E_SERVER=dev; E2E_SKIP_BUILD=1 reuses the last build. Extra arguments go to Playwright (for example --project=desktop).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
web="$root/apps/web"
# shellcheck source=e2e-env-guard.sh
source "$root/scripts/e2e-env-guard.sh"
GUARD_FILE="$web/.env.local"
GUARD_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-e2e/$(printf '%s' "$root" | sha256sum | cut -c1-16)"

# Left by the first version of this script (Nov 9), which moved a symlink here and could not restore it.
if guard_present "$GUARD_DIR/web.env.local"; then
  echo "e2e:brain: $GUARD_DIR/web.env.local is left from an older run. Check apps/web/.env.local is in place, then delete it." >&2
  exit 1
fi

# A previous run killed before its trap ran: put the file back first (set -e stops here if that fails).
guard_restore

for f in "$web"/.env*; do
  guard_present "$f" || continue
  if [[ "$f" != "$GUARD_FILE" ]]; then
    echo "e2e:brain: $(basename "$f") is in apps/web; only .env.local is moved automatically. Move it aside and retry." >&2
    exit 1
  fi
done

if ! supabase status --workdir "$root/supabase/core" >/dev/null 2>&1; then
  echo "e2e:brain: local Supabase is not running. Start it with: pnpm db:start" >&2
  exit 1
fi

guard_install_trap
guard_stash

# Playwright's browser libraries installed in user space (no sudo on this machine).
pwlibs="$HOME/.local/share/pw-libs/root/usr/lib/x86_64-linux-gnu"
if [[ -d "$pwlibs" ]]; then
  export LD_LIBRARY_PATH="$pwlibs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export E2E_SERVER="${E2E_SERVER:-build}"

cd "$web"
# Not exec: the EXIT trap must run after Playwright finishes.
pnpm exec playwright test e2e/onboarding.spec.ts e2e/brain-interview.spec.ts e2e/shell.spec.ts "$@"
