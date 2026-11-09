# Sourced by scripts/e2e-brain.sh (tested by scripts/e2e-env-guard.test.mjs). Moves one env file out of the way for an
# e2e run and puts it back exactly as it was. Never reads, copies or prints the file's contents.
#
# Set before calling:  GUARD_FILE  the file to move aside (apps/web/.env.local)
#                      GUARD_DIR   where it waits (outside the worktree, created with mode 700)
#
# A REGULAR FILE is moved to "$GUARD_DIR/file" and moved back.
# A SYMLINK (apps/web/.env.local -> ../../.env.local) is NOT moved: a relative link would point somewhere else from
# GUARD_DIR. Its target (readlink) is recorded in "$GUARD_DIR/link", the link is removed, and on restore it is recreated
# with `ln -s <target>`. The record is written before the link is removed.
# Nothing in GUARD_DIR is deleted until the restore has succeeded. Presence checks use -e OR -L, so a dangling link
# counts as present.

guard_present() { [[ -e "$1" || -L "$1" ]]; }

guard_has_backup() { [[ -f "$GUARD_DIR/link" ]] || guard_present "$GUARD_DIR/file"; }

# Moves GUARD_FILE aside. Returns 0 with nothing to do when it is absent.
guard_stash() {
  guard_present "$GUARD_FILE" || return 0
  if guard_has_backup; then
    echo "e2e-env-guard: a backup already exists in $GUARD_DIR; restore it first." >&2
    return 1
  fi
  (umask 077 && mkdir -p "$GUARD_DIR") || return 1
  chmod 700 "$GUARD_DIR" || return 1
  if [[ -L "$GUARD_FILE" ]]; then
    local target
    target="$(readlink "$GUARD_FILE")" || return 1
    printf '%s' "$target" >"$GUARD_DIR/link.tmp" || return 1
    mv "$GUARD_DIR/link.tmp" "$GUARD_DIR/link" || return 1
    # Only the link itself goes (rm on a symlink never touches its target).
    rm "$GUARD_FILE" || return 1
    echo "e2e-env-guard: removed the symlink $(basename "$GUARD_FILE") -> $target for the run (recreated on exit)"
  else
    mv "$GUARD_FILE" "$GUARD_DIR/file" || return 1
    echo "e2e-env-guard: moved $(basename "$GUARD_FILE") aside for the run (restored on exit)"
  fi
}

# Puts GUARD_FILE back. Returns 0 with nothing to do when there is no backup. Refuses (1) and touches nothing when both
# the file and a backup exist. On any failure the backup stays where it is.
guard_restore() {
  guard_has_backup || return 0
  if guard_present "$GUARD_FILE"; then
    echo "e2e-env-guard: both $GUARD_FILE and a backup in $GUARD_DIR exist; left both untouched. Keep the right one by hand." >&2
    return 1
  fi
  if [[ -f "$GUARD_DIR/link" ]]; then
    local target
    target="$(cat "$GUARD_DIR/link")" || return 1
    if ! ln -s "$target" "$GUARD_FILE" || [[ "$(readlink "$GUARD_FILE")" != "$target" ]]; then
      echo "e2e-env-guard: could not recreate the symlink $GUARD_FILE -> $target; the record stays in $GUARD_DIR/link." >&2
      return 1
    fi
    rm "$GUARD_DIR/link"
    echo "e2e-env-guard: recreated the symlink $(basename "$GUARD_FILE") -> $target"
  else
    if ! mv "$GUARD_DIR/file" "$GUARD_FILE"; then
      echo "e2e-env-guard: could not move $GUARD_DIR/file back to $GUARD_FILE; it stays in $GUARD_DIR." >&2
      return 1
    fi
    echo "e2e-env-guard: restored $(basename "$GUARD_FILE")"
  fi
}

# Restores on every exit of the calling shell: normal end, failure under set -e, `exit N`, Ctrl-C, TERM, HUP. A failed
# restore is reported and turns the exit code into 1. Install it BEFORE guard_stash.
guard_on_exit() {
  local code=$?
  if ! guard_restore; then
    echo "e2e-env-guard: RESTORE FAILED. $GUARD_FILE is still in $GUARD_DIR (file, or link = the symlink target)." >&2
    code=1
  fi
  exit "$code"
}
guard_install_trap() {
  trap guard_on_exit EXIT
  trap 'exit 130' INT TERM HUP
}
