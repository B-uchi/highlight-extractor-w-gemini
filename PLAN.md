# Basketball Highlight Extractor — Implementation Plan

## Open Questions Answered

### Gemini File Splitting Condition

Gemini 2.5 Flash has a **1M token** context window. Video is sampled at **1 FPS** and each
frame costs **258 tokens**, which gives a theoretical ceiling of ~64 minutes per request.
Accounting for the system prompt (~3K tokens) and structured JSON response (~10K tokens for
many clips), the safe per-request limit is:

**Split at 45 minutes.**

- Videos ≤ 45 min → 1 Gemini call, no splitting.
- Videos > 45 min → chunked into 45-min segments (FFmpeg `ss`/`t` cuts), each chunk uploaded
  separately to the Gemini Files API.
- Each chunk gets an index (0, 1, 2…). Timestamps returned by Gemini for chunk N are offset
  by `N × 2700` seconds before being stored.
- Chunks are analyzed **in parallel**, results merged and re-ranked by confidence + interest.
- Clips straddling a chunk boundary (within 10s of the boundary) are deduplicated by keeping
  the higher-confidence version.
- All chunk-level `gemini_file_id` values are stored separately (one row per chunk) so expiry
  and re-upload can be handled per-chunk, not per-full-video.

A typical NBA broadcast is ~2.5 hours → 4 chunks. Actual game time is 48 min → 1–2 chunks.
This approach stays well within Gemini limits at every game length.

### FFmpeg vs Alternatives for Clip Cutting

**Keep FFmpeg** (`fluent-ffmpeg` + `ffmpeg-static` already installed). Nothing lighter is
meaningfully better for server-side use:

- `moviepy` — Python overhead, slower, requires subprocess anyway.
- `@ffmpeg/wasm` — browser-only, not suitable for server.
- Cloud transcoding APIs (Cloudflare Media, Mux) — add per-minute cost and latency.

FFmpeg with a 2-second pre-seek buffer gives frame-accurate cuts without full re-encode cost:

```bash
ffmpeg -ss {start - 2} -i input.mp4 \
       -ss 2 -t {duration} \
       -c:v libx264 -preset fast -crf 22 \
       -c:a aac -b:a 128k \
       -movflags +faststart \
       clip.mp4
```

The pre-seek trick decodes from the nearest keyframe before the target, then the second `-ss 2`
seeks accurately within the decoded stream. This produces clean cuts without decoding the entire
video from the start.

---

## Architecture

```
Browser
  │
  ▼
Next.js App  (UI + API Routes)
  │
  ├── Supabase Postgres  (conversations, messages, jobs, clips)
  │
  ├── Cloudflare R2  (raw video files, generated clip files)
  │
  ├── Gemini Files API  (temporary video hosting for analysis, 48h TTL)
  │     └─ expiry tracked per chunk → auto-reupload from R2 on demand
  │
  ├── Gemini 2.0 Flash Lite  (pre-step: extract action target from prompt)
  │
  ├── Gemini 2.5 Flash  (main: analyze video → structured timestamps + titles)
  │
  └── FFmpeg  (cut clips from timestamps, upload output to R2)
```

---

## Database Schema (Supabase / Postgres)

### `conversations`
```sql
id                      uuid primary key default gen_random_uuid()
title                   text not null
status                  text not null default 'awaiting_video'
  -- awaiting_video | active | archived
r2_video_key            text        -- R2 object key
video_filename          text        -- original filename (used as initial title)
video_duration_secs     integer     -- total duration, needed for chunk planning
created_at              timestamptz default now()
updated_at              timestamptz default now()
archived_at             timestamptz
```

### `video_chunks`
One row per Gemini-uploaded chunk (1 row for short videos, N rows for long ones).
```sql
id                      uuid primary key default gen_random_uuid()
conversation_id         uuid references conversations(id) on delete cascade
chunk_index             integer not null default 0
start_sec               float not null default 0
end_sec                 float not null
gemini_file_id          text        -- Gemini Files API file ID
gemini_expires_at       timestamptz -- 48h from upload
created_at              timestamptz default now()
updated_at              timestamptz default now()
unique (conversation_id, chunk_index)
```

### `messages`
```sql
id                      uuid primary key default gen_random_uuid()
conversation_id         uuid references conversations(id) on delete cascade
role                    text not null   -- user | assistant
content                 text not null
job_id                  uuid references jobs(id)  -- set on user messages that trigger a job
created_at              timestamptz default now()
```

### `jobs`
```sql
id                      uuid primary key default gen_random_uuid()
conversation_id         uuid references conversations(id) on delete cascade
message_id              uuid references messages(id)
mode                    text not null default 'action_extraction'
  -- action_extraction | highlight_compilation_individual | highlight_compilation_team
status                  text not null default 'pending'
  -- pending | extracting_target | analyzing | extracting_clips | stitching | done | error | unsupported
prompt                  text not null
extracted_target        text            -- action (extraction) or player/team description (compilation)
jersey_number           text            -- set if identified in pre-step (individual compilation)
jersey_color            text            -- set if identified in pre-step (team or fallback individual)
clip_limit              integer         -- null = no limit (action_extraction only)
follow_up_secs          integer         -- null = no follow-up (action_extraction only)
include_audio           boolean not null default true  -- for compilations
clips_total             integer         -- set after analysis, for progress display
clips_done              integer default 0
compilation_r2_key      text            -- R2 key for the stitched video (compilation mode only)
compilation_r2_url      text            -- presigned URL for the stitched video
error_message           text
created_at              timestamptz default now()
updated_at              timestamptz default now()
```

### `clips`
Used by both modes. For compilation jobs, these are the source clips before stitching.
```sql
id                      uuid primary key default gen_random_uuid()
job_id                  uuid references jobs(id) on delete cascade
conversation_id         uuid references conversations(id)
title                   text not null   -- "3-Point Shot — #23" or "Dunk"
description             text
start_sec               float not null
end_sec                 float not null
follow_up_end_sec       float           -- end_sec + follow_up_secs, null if none
rank                    integer not null  -- 1-based; for compilations = timestamp order
jersey_number           text            -- if visible; null otherwise
jersey_color            text            -- if visible; null otherwise
r2_clip_key             text
r2_clip_url             text            -- presigned URL (refreshed on demand)
created_at              timestamptz default now()
```

---

## Phase 0: Dead Code & Dependency Cleanup

Remove everything that is not needed for the new architecture. This is a significant cleanup
since the existing pipeline (Whisper, BullMQ, CV worker, category packs, agent orchestrator)
is being replaced with a simpler direct-Gemini approach.

**Delete entirely:**
- `lib/pipeline/` — old Whisper + ranking + scene detection pipeline
- `lib/categories/` — multi-category system (basketball-specific now)
- `lib/agent/` — multi-turn tool-calling agent (replaced by direct job handlers)
- `lib/queue.ts` + `scripts/worker.ts` — BullMQ / Redis queue
- `lib/cv/client.ts` — Python CV worker
- `lib/openai.ts` — Whisper / OpenAI dependency
- `lib/reel.ts` — reel building
- `lib/observability.ts` — Prometheus metrics
- `lib/cache.ts` — JSON file cache
- `lib/concurrency.ts` — rate limiter (use Gemini SDK's built-in retry)
- `lib/playerFocus.ts`, `lib/conversationTargeting.ts` — replaced by jersey number/color tracking in jobs
- `lib/defaultActions.ts` — processing presets UI system; quality rules and ranking order are
  extracted and embedded directly into the Gemini analysis prompts (see Phase 3)
- `lib/highlightCap.ts` — replaced by `clip_limit` on the job
- `lib/dbSchema.ts`, `lib/db.ts` — Drizzle ORM (replaced by Supabase)
- `drizzle/`, `drizzle.config.ts` — migrations
- `app/api/process/` — legacy bulk upload
- `app/api/reel/` — reel building
- `app/api/metrics/` — Prometheus
- `app/api/status/` — old SSE job status (replaced by `/api/jobs/[id]`)
- `app/api/input/` — old video serving
- `app/api/conversations/[id]/targeting/` — player focus targeting
- `scripts/evals/`, `scripts/smoke-test.ts` — unmaintained
- `scripts/dev-cv-worker.sh` — CV worker
- `docs/PLAYER_FOCUS.md`, `docs/DEFAULT_PROCESSING_PRESETS.md`
- `next.md` — old roadmap (this document replaces it)

**Remove npm packages:**
- `openai`, `bullmq`, `ioredis`, `prom-client`, `@opentelemetry/*`
- `drizzle-orm`, `drizzle-kit`, `postgres`

**Keep and adapt:**
- `lib/gemini.ts` → extend with new methods
- `lib/ffmpeg.ts` → extend for clip cutting with pre-seek
- `lib/storage.ts` → adapt for R2 only
- `lib/format.ts` → keep as-is
- `lib/networkErrors.ts` → keep as-is
- `lib/types.ts` → full rewrite with new types
- `lib/config.ts` → update env vars

**Add:**
- `@supabase/supabase-js`

---

## Phase 1: Infrastructure & Config

**1.1 Supabase Client (`lib/supabase.ts`)**
- Browser client: `createBrowserClient(url, anonKey)` — for Realtime subscriptions in UI.
- Server client: `createClient(url, serviceRoleKey)` — for all API routes (bypasses RLS).
- No RLS policies needed yet (no auth).

**1.2 R2 Storage (`lib/storage.ts`, rewritten)**
- R2 uses the S3-compatible API (`@aws-sdk/client-s3` already installed).
- Endpoint: `https://<account-id>.r2.cloudflarestorage.com`.
- Functions:
  - `uploadVideoStream(stream, key)` → uploads via multipart, returns key.
  - `uploadClipBuffer(buffer, key)` → single-part upload, returns key + presigned URL.
  - `getPresignedUrl(key, expiresInSecs)` → signed GET URL.
  - `downloadToTemp(key)` → streams R2 object to a local temp file path.

**1.3 Updated Environment Variables**
```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=

# Gemini (already exists)
GEMINI_API_KEY=
```

---

## Phase 2: Conversation & Video Upload

**2.1 Conversation API**

`GET /api/conversations`
- Returns list of non-archived conversations ordered by `updated_at` desc.
- Shape: `{ id, title, status, created_at }[]`

`POST /api/conversations`
- Creates conversation with `status: 'awaiting_video'`, title: "New Conversation".
- Returns created record.

`GET /api/conversations/[id]`
- Returns conversation + all messages (ordered by `created_at`) + all clips grouped by `job_id`.

`PATCH /api/conversations/[id]`
- Body: `{ title?: string, archived?: boolean }`.

**2.2 Video Upload & Pre-processing**

`POST /api/conversations/[id]/upload` (multipart form, field: `video`)

Pre-processing is non-negotiable: raw broadcast footage can be 10–40 GB. Transcoding to
720p H.264 before storage keeps files manageable for R2 transfer and Gemini upload.

Steps:
1. Validate conversation exists and `status === 'awaiting_video'`.
2. Stream the incoming multipart body to a local temp file (do not buffer in memory).
   This avoids holding the full video in RAM.
3. **Pre-process with FFmpeg:**
   ```bash
   ffmpeg -i input.{ext} \
          -vf scale=-2:720 \
          -c:v libx264 -preset fast -crf 23 \
          -c:a aac -b:a 128k \
          -movflags +faststart \
          processed.mp4
   ```
   Output: `tmp/{conversationId}/processed.mp4`
4. Stream `processed.mp4` to R2.
   - Key: `videos/{conversationId}/{timestamp}.mp4`
5. Run `ffprobe` on `processed.mp4` to get duration in seconds.
6. Plan chunks: `chunkCount = Math.ceil(durationSecs / 2700)`
7. For each chunk index `i` (sequentially — Gemini rate limits):
   - Extract with FFmpeg:
     ```bash
     ffmpeg -ss {i * 2700} -i processed.mp4 -t 2700 -c copy chunk_{i}.mp4
     ```
   - Upload `chunk_{i}.mp4` to Gemini Files API.
   - Insert `video_chunks` row: `{ conversationId, chunk_index: i, start_sec: i*2700,
     end_sec: min((i+1)*2700, durationSecs), gemini_file_id, gemini_expires_at: now()+48h }`.
8. Update conversation: `status → 'active'`, `title → filename (without ext)`,
   `video_filename`, `video_duration_secs`, `r2_video_key`.
9. Delete temp files.
10. Return `{ conversationId, chunks: chunkCount, durationSecs }`.

The upload endpoint streams progress back as JSON lines so the UI can show a multi-step
progress bar: `Preprocessing... → Uploading to storage... → Preparing for analysis (N/M chunks)...`

**2.3 Gemini File Expiry (`lib/gemini.ts`)**

`ensureChunksReady(conversationId)`:
1. Fetch all `video_chunks` for this conversation.
2. For each chunk where `gemini_expires_at < now() + 1 hour` (about to expire or expired):
   a. Download that chunk from R2 to a temp file (or re-extract from the original video).
   b. Re-upload to Gemini Files API.
   c. Update `video_chunks` row with new `gemini_file_id` and `gemini_expires_at`.
3. Return array of `{ chunkIndex, geminiFileId }`.

This is called at the start of every job run, before any analysis begins.

---

## Phase 3: Prompt Processing Pipeline

**3.1 Send Message & Trigger Job**

`POST /api/conversations/[id]/messages`

Body: `{ prompt: string, followUpSecs?: number, clipLimit?: number }`

Steps:
1. Validate `conversation.status === 'active'`. If not: `400 { error: 'Upload a video first' }`.
2. Check no job for this conversation is currently `pending | extracting_target | analyzing | extracting_clips`.
   If one is running: `409 { error: 'A job is already in progress' }`.
3. Insert user message row.
4. Insert job row with `status: 'pending'`.
5. Update user message with `job_id`.
6. Kick off `processJob(jobId)` asynchronously (`setImmediate` in dev, cron fallback in prod).
7. Return `{ messageId, jobId }`.

**3.2 Pre-Step Prompt (Gemini Flash Lite)**

Classifies the prompt and extracts tracking info. Called for every job regardless of mode.

```
You are classifying a basketball video highlight request.

Determine the type and extract relevant identifiers.

Return JSON only, no markdown:
{
  "mode": "action_extraction" | "highlight_compilation_individual" | "highlight_compilation_team" | "unsupported",
  "target": "<description of what to find or who to highlight>",
  "jerseyNumber": "<number if mentioned, e.g. '23', null otherwise>",
  "jerseyColor": "<color if mentioned, e.g. 'blue', null otherwise>",
  "teamName": "<team name if mentioned, null otherwise>",
  "includeAudio": true,
  "supported": true | false
}

Mode definitions:
- action_extraction: request for specific actions/events (dunks, blocks, steals, assists, etc.)
- highlight_compilation_individual: request for all highlights of a specific player
- highlight_compilation_team: request for all highlights of a team
- unsupported: cannot result in video clip output (score summaries, questions, descriptions)

Set supported to false for unsupported mode.
Set includeAudio to false if the prompt mentions "no audio", "silent", "mute", or "without audio/sound".

Examples:
- "show me all dunks" → action_extraction, target="dunks"
- "find blocks by #5" → action_extraction, target="blocks", jerseyNumber="5"
- "every fast break in Q3" → action_extraction, target="fast breaks in Q3"
- "make a highlight for #23" → highlight_compilation_individual, jerseyNumber="23"
- "player highlight for the blue #15" → highlight_compilation_individual, jerseyNumber="15", jerseyColor="blue"
- "team reel for the red team" → highlight_compilation_team, jerseyColor="red"
- "team highlight for Triple Threat no audio" → highlight_compilation_team, teamName="Triple Threat", includeAudio=false
- "who scored the most?" → unsupported

User prompt: "{prompt}"
```

**3.3 Job Pipeline (`lib/jobs.ts`)**

`processJob(jobId)` branches on `job.mode` after the pre-step:

```
Step 1: extracting_target (all modes)
  → Call Gemini Flash Lite → parse classification JSON
  → If mode=unsupported: job → 'unsupported', create assistant message, done
  → Store mode, extracted_target, jerseyNumber, jerseyColor, teamName, includeAudio
  → job → 'analyzing'

Step 2: analyzing (all modes)
  → Call ensureChunksReady(conversationId) → get chunk file IDs
  → For each chunk (parallel, max 3 concurrent):
      Call Gemini 2.5 Flash with chunk file + mode-specific prompt
      Parse structured JSON response
      Offset timestamps by chunk.start_sec
  → Merge results from all chunks
  → Deduplicate clips within 10s of chunk boundaries (keep higher confidence)
  → MODE SPLIT:
      action_extraction: sort by rank, apply clip_limit
      compilation: sort by start_sec (timestamp order)
  → Set job.clips_total, job → 'extracting_clips'

Step 3: extracting_clips (all modes)
  → Download preprocessed video from R2 to temp dir (once, reused for all clips)
  → For each clip (max 3 concurrent):
      FFmpeg cut with pre-seek buffer → output to temp file
      Upload clip to R2: clips/{conversationId}/{jobId}/{rank}-{clipId}.mp4
      Insert clips row with presigned URL
      Increment job.clips_done

Step 4 (compilation only): stitching
  → job → 'stitching'
  → Generate FFmpeg concat file listing all temp clip paths in rank/timestamp order
  → FFmpeg concat: with audio if includeAudio, strip audio track otherwise
  → Upload stitched video to R2: compilations/{conversationId}/{jobId}/highlight.mp4
  → Store compilation_r2_key + compilation_r2_url on job

Final:
  → job → 'done'
  → Create assistant message:
      action_extraction: "Found {N} clips for: {extracted_target}"
      compilation: "Highlight compiled — {N} plays for {extracted_target}"
  → Clean up all temp files
```

**3.4 Main Analysis Prompt — Action Extraction (Gemini 2.5 Flash)**

```
You are a professional basketball video analyst reviewing real game footage.
This is a recording of an actual basketball game — not a highlight reel or animation.

TASK: Find every instance of the following action in this video:
"{extracted_target}"
{jersey_filter_instruction}

TIMESTAMP RULES (critical):
- start_sec: the moment the action begins to develop
  (player starts moving, ball leaves hands, defender closes out)
- end_sec: the moment the action is fully complete
  (ball through net, ball secured after rebound, player lands, whistle blown)
- Return tight, precise timestamps. Do NOT add any padding.
- Timestamps are in seconds from the start of this video segment.

QUALITY RULES:
- Only include clips where the player is clearly visible and the action is meaningful.
- The play result must be positive or defensively impactful.
- Omit dead time, inbound delays, and free throws (unless completing an and-1).
- Omit any clip where the player is not clearly identifiable.
- Omit clips with confidence below 0.6.

RANKING (1 = most valuable):
Dunks > Blocks > Steals leading to points > Made 3-pointers > Assists >
Tough finishes/and-1s > Transition plays > Rebounds > Defensive stops > Hustle plays
{clip_limit_instruction}

Return a JSON array only, no markdown:
[
  {
    "title": "<Action> — #<jersey>" (omit jersey part if not visible),
    "description": "1–2 sentences on exactly what happens",
    "start_sec": float,
    "end_sec": float,
    "rank": integer,
    "confidence": float,
    "jerseyNumber": "<number string or null>",
    "jerseyColor": "<color string or null>"
  }
]

Return [] if no instances are found.
```

`jersey_filter_instruction`:
- If `jerseyNumber` set: `"Focus on the player wearing jersey #N. Ignore plays by other players."`
- If only `jerseyColor` set: `"Focus on players wearing {color} jerseys. Ignore other teams."`
- If neither: omit (find all instances regardless of player)

`clip_limit_instruction`:
- If `clip_limit` set: `"Return at most {N} clips, keeping the highest-ranked."`
- Otherwise: omit

**3.5 Main Analysis Prompt — Highlight Compilation (Gemini 2.5 Flash)**

Individual and team compilations use the same prompt structure, differing only in the filter.

```
You are a professional basketball video analyst reviewing real game footage.
This is a recording of an actual basketball game — not a highlight reel or animation.

TASK: Find ALL positive basketball plays involving {compilation_subject} in this video.

{compilation_subject} is one of:
- Individual: "the player wearing jersey #{jerseyNumber}" or "the player wearing {jerseyColor} jersey"
  (if both: "the player wearing #{jerseyNumber} on the {jerseyColor} team")
- Team: "the {jerseyColor} team" or "the {jerseyColor} team ({teamName})"

PLAYS TO INCLUDE:
Made shots (all types), dunks, assists, hockey assists, rebounds (offensive and defensive),
steals, blocks, deflections, fast breaks, tough finishes through contact, and-1 plays,
charges taken, ball handling breakdowns, good passes, and hustle plays.

QUALITY RULES:
- Player/team must be clearly visible and directly involved in the play.
- Result must be positive or defensively impactful.
- Omit dead time, inbound delays, free throws (unless and-1 completion).
- Omit clips where the player/team is not clearly identifiable.
- Omit clips with confidence below 0.6.

TIMESTAMP RULES:
- start_sec: 1 second before the play begins to develop
- end_sec: 2 seconds after the play is fully complete
- (These are wider than action extraction — the padding is intentional for compilation flow.)
- Timestamps are in seconds from the start of this video segment.

ORDER: Return clips in chronological order (ascending start_sec).

Return a JSON array only, no markdown:
[
  {
    "title": "<Action> — #{jersey}" (omit jersey part if not visible),
    "description": "1–2 sentences on exactly what happens",
    "start_sec": float,
    "end_sec": float,
    "rank": integer (chronological order, 1 = earliest),
    "confidence": float,
    "jerseyNumber": "<number string or null>",
    "jerseyColor": "<color string or null>"
  }
]

Return [] if no qualifying plays are found.
```

**3.6 Follow-Up Seconds (action extraction only)**

When `follow_up_secs` is set on the job, FFmpeg cuts to `end_sec + follow_up_secs`:
- `clips.follow_up_end_sec = end_sec + follow_up_secs` (stored for reference)
- `start_sec`/`end_sec` on the clips row remain the tight action timestamps from Gemini

This option is not available for compilation mode (compilation prompts already include 2s post-play padding).

**3.7 Video Stitching (compilation only)**

```bash
# Generate concat file
file '/tmp/{jobId}/clip_1.mp4'
file '/tmp/{jobId}/clip_2.mp4'
...

# With audio
ffmpeg -f concat -safe 0 -i concat.txt \
       -c:v libx264 -preset fast -crf 22 \
       -c:a aac -b:a 128k \
       -movflags +faststart \
       highlight.mp4

# Without audio
ffmpeg -f concat -safe 0 -i concat.txt \
       -c:v libx264 -preset fast -crf 22 \
       -an \
       -movflags +faststart \
       highlight.mp4
```

---

## Phase 4: API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/conversations` | GET | List conversations |
| `/api/conversations` | POST | Create conversation |
| `/api/conversations/[id]` | GET | Conversation + messages + clips |
| `/api/conversations/[id]` | PATCH | Rename / archive |
| `/api/conversations/[id]/upload` | POST | Upload video → preprocess → R2 → Gemini (streams progress) |
| `/api/conversations/[id]/messages` | POST | Send prompt → create job |
| `/api/jobs/[jobId]` | GET | Job status + clips + compilation URL |
| `/api/clips/[clipId]/url` | GET | Fresh presigned R2 URL (auto-refreshes on expiry) |
| `/api/cron/process-jobs` | GET | Cron fallback: pick up stuck pending jobs |

The `/api/cron/process-jobs` route requires a `CRON_SECRET` header and picks up any job
in `pending` status older than 60 seconds (covers dev restart or Vercel cold-start gaps).

---

## Phase 5: UI Components

### Layout

```
┌─────────────┬────────────────────────────────────┬──────────────────┐
│  Sidebar    │  Chat Area                          │  Clip Viewer     │
│             │                                     │  (collapsible)   │
│ [+] New     │  ┌─────────────────────────────┐   │                  │
│             │  │  Upload zone (awaiting)      │   │  ← opens when   │
│ Conv 1  ●   │  │  or                          │   │    clip result   │
│ Conv 2      │  │  Message list (active)       │   │    is clicked    │
│ Conv 3      │  └─────────────────────────────┘   │                  │
│             │                                     │                  │
│             │  ┌─────────────────────────────┐   │                  │
│             │  │  Prompt input               │   │                  │
│             │  │  [ ] Follow-up [3] sec      │   │                  │
│             │  │  Clips: [All ▼]  [Send]     │   │                  │
│             │  └─────────────────────────────┘   │                  │
└─────────────┴────────────────────────────────────┴──────────────────┘
```

### Components

**`ConversationList`** — sidebar list. Each item shows title, status dot (gray=awaiting,
green=active), relative timestamp. "New Conversation" button at top.

**`UploadZone`** — shown in main area when `status === 'awaiting_video'`. Drag-and-drop or
click. Shows upload progress bar. On complete, transitions the UI to the chat view.

**`UploadZone`** — shown in main area when `status === 'awaiting_video'`. Drag-and-drop or
click to select. On upload start, shows a multi-step progress bar:
```
✓ File received
⏳ Preprocessing video...
⏳ Uploading to storage...
⏳ Preparing for analysis (chunk 2/3)...
✓ Ready
```
Streams progress from the upload endpoint (JSON lines). On complete, transitions UI to chat.

**`ChatMessage`** — renders a single message:
- User message: right-aligned bubble with prompt text.
- Assistant "unsupported" message: left-aligned bubble with explanation.
- Assistant "job running" message: `JobStatusCard` (live-updating, stops when done).
- Assistant "action extraction done" message: `ClipResultCard` — "Found N clips for: {target}",
  list of clip titles with rank badges. Clicking opens `ClipViewer` with the individual clips.
- Assistant "compilation done" message: `CompilationResultCard` — shows the stitched video
  inline with a play button, download button, and an expandable "View source clips" section
  that lists the N individual clips that went into the reel.

**`JobStatusCard`** — polling card shown while job runs. Stops polling on terminal states.
Specific steps shown depend on mode:

Action extraction:
```
● Extracting action from prompt...
● Analyzing video (chunk 2/3)...
● Cutting clips (4/7)...
✓ Done — 7 clips found
```

Compilation:
```
● Identifying player/team from prompt...
● Analyzing video for all plays (chunk 2/3)...
● Cutting source clips (12/18)...
● Stitching highlight reel...
✓ Done — 18 plays compiled
```

**`ClipViewer`** — right panel (action extraction only):
- Slides in from right when a `ClipResultCard` is clicked.
- Header: prompt text + minimize/close buttons.
- Clips list (scrollable). Each clip card:
  - Rank badge, title, description, duration badge, jersey badge (if available).
  - Click clip → inline `<video>` player opens below the card (autoplay).
  - Download button → hits `/api/clips/[clipId]/url` for fresh presigned URL.
- Can be minimized back to an icon in the chat message.

**`PromptInput`** — bottom of chat:
- Textarea (Enter submits, Shift+Enter newline).
- Options row (shown below textarea):
  - [ ] Include follow-up  [ 3 ] sec — hidden until checked; only relevant for action extraction,
    but always visible since mode isn't known until the pre-step runs.
  - Clips: [All ▼] — dropdown (All / 5 / 10 / 15 / 20); only applies to action extraction.
- Submit button: disabled when `status !== 'active'` or a job is currently running.

---

## Phase 6: Background Processing

**Development (local):** `processJob` fires via `setImmediate` after job insertion.
Next.js keeps the Node process alive, so the job completes in the background.

**Production (Vercel):** Use `waitUntil` from `@vercel/functions`:
```ts
import { waitUntil } from '@vercel/functions'
waitUntil(processJob(jobId))
```
This keeps the serverless function alive after the HTTP response is sent.

**Cron fallback:** `/api/cron/process-jobs` scheduled every 60 seconds via `vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron/process-jobs", "schedule": "* * * * *" }]
}
```
Picks up any job in `pending` status older than 60 seconds and reruns it. Idempotent
because each step checks current job status before proceeding.

---

## File Structure After Refactor

```
lib/
  supabase.ts              # Supabase server + browser clients
  storage.ts               # R2: multipart upload, stream download, presign, expiry refresh
  gemini.ts                # Gemini client, ensureChunksReady, extractTarget, analyzeChunk
  ffmpeg.ts                # preprocess(), cutClip(), stitchClips(), ffprobe()
  jobs.ts                  # processJob() — full pipeline, branches on mode
  prompts.ts               # buildActionExtractionPrompt(), buildCompilationPrompt(), PRE_STEP_PROMPT
  format.ts                # formatDuration, formatTimestamp
  types.ts                 # All TypeScript interfaces (Conversation, Job, Clip, VideoChunk, etc.)

app/api/
  conversations/
    route.ts               # GET list / POST create
    [id]/
      route.ts             # GET detail / PATCH rename+archive
      upload/route.ts      # POST upload → preprocess → R2 → Gemini (streaming JSON lines)
      messages/route.ts    # POST send prompt → create job → kick processJob
  jobs/
    [jobId]/route.ts       # GET status + clips + compilation_r2_url
  clips/
    [clipId]/
      url/route.ts         # GET fresh presigned URL (private R2)
  cron/
    process-jobs/route.ts  # GET cron fallback (CRON_SECRET protected)

components/dashboard/
  DashboardShell.tsx           # layout: sidebar + main area
  ConversationList.tsx         # sidebar conversation list + new button
  ConversationWorkspace.tsx    # top-level: upload zone | chat + clip viewer
  UploadZone.tsx               # drag-drop upload with multi-step progress
  ChatMessage.tsx              # routes to correct card type based on message metadata
  JobStatusCard.tsx            # live-polling progress card (action | compilation variants)
  ClipResultCard.tsx           # action extraction result: N clips, opens ClipViewer
  CompilationResultCard.tsx    # compilation result: inline video player + expandable source clips
  ClipViewer.tsx               # right panel: ranked clip list with inline video player
  PromptInput.tsx              # textarea + follow-up + clip limit options
```

---

## Implementation Order

1. **Phase 0** — clean up dead code and packages. Get the app compiling clean.
2. **Phase 1** — Supabase schema + client, R2 storage adapter, env config.
3. **Phase 2** — conversation CRUD API + video upload endpoint (R2 + Gemini Files).
4. **Phase 3** — `processJob` pipeline: target extraction → analysis → clip cutting.
5. **Phase 4** — remaining API routes (jobs status, clip URLs, cron).
6. **Phase 5** — UI: layout → upload zone → chat → job status card → clip viewer → prompt input.
7. **Polish** — rename conversation, archive, error states, empty states.

---

## Decisions Made

1. **R2 bucket:** Private. All video and clip access via presigned URLs (auto-refreshed on expiry).
   Each clip card in the UI has a download button that resolves to a fresh presigned URL.
2. **Video pre-processing:** Non-negotiable. Transcode to 720p H.264 before upload.
3. **Job status updates:** Polling every 2s.
4. **Gemini chunk tracking:** Multi-row `video_chunks` table (one row per chunk, per-chunk expiry).
5. **Clip serving:** Direct from R2 via presigned URL (no Next.js proxy).

---

## Two Distinct Job Modes

This is the core split that drives schema, pipeline, and UI differences.

### Mode A: Action Extraction
- **Prompt examples:** "show me all dunks", "find blocks by #5", "every fast break in Q3"
- **Output:** N individual clip files — one file per action instance
- **UI:** ClipViewer panel with a ranked, scrollable list of clips; each clip plays inline

### Mode B: Highlight Compilation
- **Prompt examples:** "make a highlight for #23", "team reel for the blue team",
  "player highlight for #7 no audio"
- **Sub-types:**
  - `individual` — identify all positive plays by a specific player (jersey number OR jersey color)
  - `team` — identify all positive plays by a team (jersey color + optional team name)
- **Output:** one stitched video file containing all identified plays in timestamp order
- **UI:** single video player with a download button; optionally expandable to see source clips

The pre-step (Gemini Flash Lite) classifies the prompt into one of:
- `action_extraction`
- `highlight_compilation_individual`
- `highlight_compilation_team`
- `unsupported`

### Tracking

Tracking (who is being highlighted) works as follows:
- **Jersey number:** primary identifier when visible in the video. Returned as `jerseyNumber` on clips.
- **Jersey color:** fallback identifier when number is not readable. Returned as `jerseyColor`.
- **Neither visible:** clip omitted (not included in output). Never guess.
- For team highlights: jersey color is the primary filter; team name is support context in the prompt,
  not a visual identifier.

---

## Quality & Ranking Guidelines (embedded in prompts)

The following rules (derived from `lib/defaultActions.ts`) are **not user-facing presets** — they
are baked into the main analysis prompt for all job modes:

**Clip Quality Rules:**
- Only select clips where the player/team is clearly visible and the action is meaningful.
- Result must be positive (or defensively impactful).
- Remove dead time, inbound delays, and free throws (unless completing an and-1).
- Omit clips where the player is not clearly identifiable.

**Ranking Order (for action extraction, most to least valuable):**
1. Dunks
2. Blocks
3. Steals leading to points
4. Made 3-pointers
5. Assists
6. Tough finishes through contact / and-1s
7. Transition plays
8. Rebounds
9. Defensive stops
10. Hustle plays

For highlight compilations, clips are ordered by **timestamp** (not by rank), since the output
is a chronological reel, not a ranked list.
