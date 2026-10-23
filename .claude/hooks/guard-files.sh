#!/usr/bin/env bash
# Prevents agents from editing protected files.
input=$(cat)
path=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.tool_input.file_path||"")}catch{console.log("")}})')
case "$path" in
  *.env*|*/.github/workflows/*|*/.claude/settings.json|*/.claude/hooks/*|*/CLAUDE.md|*/docs/architecture.md|*/docs/pilot-scope.md)
    echo "Blocked by guard-files: $path is protected. Propose the change in the PR description instead." >&2
    exit 2;;
esac
exit 0
