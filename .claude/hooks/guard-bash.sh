#!/usr/bin/env bash
# Blocks dangerous shell commands even if a permission rule is misconfigured.
# Exit 2 = block; stderr is shown to Claude.
input=$(cat)
cmd=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tool_input.command||"")}catch{console.log("")}})')
patterns=(
  '--prod' 'vercel deploy' 'vercel env' 'npx vercel' 'db push' 'supabase link' 'git push' 'reset --hard' 'rm -rf /' 'rm -rf ~'
  'SUPABASE_SERVICE_ROLE' 'PROD_' 'printenv' 'env |' 'cat .env' 'curl ' 'wget '
)
for p in "${patterns[@]}"; do
  if [[ "$cmd" == *"$p"* ]]; then
    echo "Blocked by guard-bash: '$p' is not allowed for agents. If this is truly needed, add it to 'Needs human' in docs/backlog.md." >&2
    exit 2
  fi
done
exit 0
