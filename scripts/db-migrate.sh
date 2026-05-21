#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Example:" >&2
  echo "  export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_highlights" >&2
  exit 1
fi

files=(
  "$root/drizzle/0000_init.sql"
  "$root/drizzle/0001_agent_tables.sql"
  "$root/drizzle/0002_conversation_player_focus.sql"
  "$root/drizzle/0003_conversation_archived_at.sql"
)

for f in "${files[@]}"; do
  echo "Applying $(basename "$f")..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "Migrations applied."
