#!/usr/bin/env bash
# Genera un archivo markdown con todo lo necesario para revisar una rama.
#
#   ./scripts/review-bundle.sh                  # rama actual contra main
#   ./scripts/review-bundle.sh main feature/x   # explícito
#
# Salida: review-bundle.md en la raíz del repo (está en .gitignore).

set -euo pipefail

BASE="${1:-main}"
HEAD_REF="${2:-$(git rev-parse --abbrev-ref HEAD)}"
OUT="review-bundle.md"
MAX_DIFF_LINES=4000

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "No existe la rama base '$BASE'" >&2
  exit 1
fi

{
  echo "# Bundle de revisión"
  echo
  echo "- Rama: \`$HEAD_REF\`"
  echo "- Base: \`$BASE\`"
  echo "- Generado: $(date -Iseconds)"
  echo

  echo "## Commits"
  echo
  echo '```'
  git log --no-merges --pretty=format:'%h %s' "$BASE..$HEAD_REF"
  echo
  echo '```'
  echo

  echo "## Archivos cambiados"
  echo
  echo '```'
  git diff --stat "$BASE...$HEAD_REF"
  echo '```'
  echo

  echo "## Diff"
  echo
  DIFF_LINES=$(git diff "$BASE...$HEAD_REF" -- . ':(exclude)pnpm-lock.yaml' | wc -l)
  if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
    echo "> Diff de $DIFF_LINES líneas, truncado a $MAX_DIFF_LINES."
    echo "> Si hace falta el resto, generá el bundle por subdirectorio."
    echo
  fi
  echo '```diff'
  git diff "$BASE...$HEAD_REF" -- . ':(exclude)pnpm-lock.yaml' | head -n "$MAX_DIFF_LINES"
  echo '```'
  echo

  echo "## Migraciones tocadas, completas"
  echo
  git diff --name-only "$BASE...$HEAD_REF" \
    | grep -E '(migrations|drizzle).*\.(sql|ts)$' || true \
    | while read -r f; do
        [ -f "$f" ] || continue
        echo "### \`$f\`"
        echo
        echo '```sql'
        cat "$f"
        echo '```'
        echo
      done

  echo "## Estado del árbol"
  echo
  echo '```'
  git status --short
  echo '```'
} > "$OUT"

echo "Listo: $OUT ($(wc -l < "$OUT") líneas)"
echo "Subilo al chat para la revisión."
