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
- `USE_DATABASE_JOBS=true` + `DATABASE_URL=...` to persist jobs in Postgres
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

Open [http://localhost:3000](http://localhost:3000), upload a video, and watch live job updates over SSE.

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

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
