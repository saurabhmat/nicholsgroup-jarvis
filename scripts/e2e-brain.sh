#!/usr/bin/env bash
# H-042: one command for the onboarding, brain-interview and shell Playwright specs (pnpm e2e:brain).
#
# The e2e server refuses to start while apps/web has a .env file (it must run against the LOCAL Supabase stack only),
# so this moves apps/web/.env.local out of apps/web for the run and ALWAYS puts it back (trap on exit, Ctrl-C included).
# The file is moved, never read, copied or printed. It waits OUTSIDE the worktree (so `git clean`, a worktree removal or
# a CLI deploy of the folder cannot touch it) in ~/.cache/jarvis-e2e/<hash of this checkout's path>/web.env.local
# (folder mode 700). If a run was killed hard (kill -9, power loss), the next run puts it back before anything else.
#
# WARNING: the run RESETS THE LOCAL DATABASE (Playwright global setup): local connections, Vault tokens and brain pages
# are wiped. Never touches a linked or production project.
#
# Defaults: E2E_SERVER=build (next build + next start; faster than next dev on a slow filesystem). Override with
# E2E_SERVER=dev; E2E_SKIP_BUILD=1 reuses the last build. Extra arguments go to Playwright (for example --project=desktop).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
web="$root/apps/web"
envfile="$web/.env.local"
backup_dir="${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-e2e/$(printf '%s' "$root" | sha256sum | cut -c1-16)"
backup="$backup_dir/web.env.local"

restore() {
  if [[ -e "$backup" ]]; then
    if [[ -e "$envfile" ]]; then
      echo "e2e:brain: both apps/web/.env.local and $backup exist; left both untouched. Keep the right one by hand." >&2
      return 1
    fi
    mv "$backup" "$envfile"
    echo "e2e:brain: restored apps/web/.env.local"
  fi
}

# A previous run killed before its trap ran: put the file back first.
if [[ -e "$backup" ]]; then
  restore
fi

for f in "$web"/.env*; do
  [[ -e "$f" ]] || continue
  if [[ "$f" != "$envfile" ]]; then
    echo "e2e:brain: $(basename "$f") is in apps/web; only .env.local is moved automatically. Move it aside and retry." >&2
    exit 1
  fi
done

if ! supabase status --workdir "$root/supabase/core" >/dev/null 2>&1; then
  echo "e2e:brain: local Supabase is not running. Start it with: pnpm db:start" >&2
  exit 1
fi

trap 'restore' EXIT
trap 'exit 130' INT TERM HUP
if [[ -e "$envfile" ]]; then
  (umask 077 && mkdir -p "$backup_dir")
  chmod 700 "$backup_dir"
  mv "$envfile" "$backup"
  echo "e2e:brain: moved apps/web/.env.local aside for the run (restored on exit)"
fi

# Playwright's browser libraries installed in user space (no sudo on this machine).
pwlibs="$HOME/.local/share/pw-libs/root/usr/lib/x86_64-linux-gnu"
if [[ -d "$pwlibs" ]]; then
  export LD_LIBRARY_PATH="$pwlibs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export E2E_SERVER="${E2E_SERVER:-build}"

cd "$web"
# Not exec: the EXIT trap must run after Playwright finishes.
pnpm exec playwright test e2e/onboarding.spec.ts e2e/brain-interview.spec.ts e2e/shell.spec.ts "$@"
