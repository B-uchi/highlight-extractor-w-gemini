# Video Highlights

General-purpose, multi-category highlight extraction pipeline with:

- Next.js API + UI
- FFmpeg audio/video chunking and clipping
- Whisper transcription
- Gemini multi-highlight ranking
- Candidate pre-filtering, category packs, and two-pass ranking
- Optional queue/worker mode, Postgres persistence, object storage, and Python CV worker

## Setup

```bash
npm install
cp .env.example .env.local
```

Set required keys:

```bash
OPENAI_API_KEY=...
GEMINI_API_KEY=...
```

Optional infra:

- `USE_QUEUE=true` + `REDIS_URL=...` to use BullMQ worker mode
- `USE_DATABASE_JOBS=true` + `DATABASE_URL=...` to persist jobs in Postgres (required for `/dashboard` conversations)

Example when using local Docker Postgres (`docker compose up -d`):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_highlights
```
- `STORAGE_MODE=s3` + storage credentials to publish clip URLs from object storage
- `ENABLE_CV_WORKER=true` + `CV_WORKER_URL=http://localhost:8000` to enable scene/CV worker hooks

## Run

```bash
npm run dev
```

Optional queue worker:

```bash
npm run worker
```

Open [http://localhost:3000](http://localhost:3000) — you’ll land on the **Agent dashboard** (`/dashboard`).

### Agent dashboard (recommended)

Conversations, chat with Gemini tool-calling, uploads, live job SSE, source preview, clips, and reels live under `/dashboard`.

**Requires Postgres for chat history:** set `USE_DATABASE_JOBS=true` and `DATABASE_URL` (see example above). Without it, conversation APIs return `503`.

Apply migrations whenever you enable the DB (existing volumes do **not** re-run Docker init scripts):

```bash
npm run db:migrate
```

Or run SQL files manually in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0000_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0001_agent_tables.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0002_conversation_player_focus.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0003_conversation_archived_at.sql
```

On a **fresh** `postgres_data` volume, `docker compose up -d` runs these files automatically via `./drizzle` mounted at `/docker-entrypoint-initdb.d`.

See [docs/PLAYER_FOCUS.md](docs/PLAYER_FOCUS.md) for structured player/team targeting (prompt steering, not full-game tracking yet).

Preset **checkbox bundles** merge boilerplate ranking instructions ahead of chat prompts — see [docs/DEFAULT_PROCESSING_PRESETS.md](docs/DEFAULT_PROCESSING_PRESETS.md).

## Evaluation

```bash
npm run eval
```

The eval harness runs fixtures from `scripts/evals/fixtures.json` and reports highlight count, latency, and token usage.

## Smoke test

```bash
npm run smoke:test
```

It runs in `MOCK_AI=true` mode and validates end-to-end clip generation.

## Legacy API

`POST /api/process` still accepts multipart upload for scripts. The UI uses the agent flow under `/dashboard` and `POST /api/conversations/:id/upload` + chat.

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Gemini API](https://ai.google.dev/docs)
