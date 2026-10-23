#!/usr/bin/env bash
# Refuses to let Claude finish while checks fail (one retry loop guard).
input=$(cat)
active=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).stop_hook_active?"1":"0")}catch{console.log("0")}})')
[[ "$active" == "1" ]] && exit 0
[[ -f package.json ]] || exit 0
command -v pnpm >/dev/null 2>&1 || exit 0
grep -q '"typecheck"' package.json || exit 0
if ! out=$(pnpm -s typecheck 2>&1 && pnpm -s lint 2>&1 && pnpm -s test 2>&1); then
  echo "Checks are failing. Fix them before finishing, or record the blocker under 'Needs human' in docs/backlog.md." >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
