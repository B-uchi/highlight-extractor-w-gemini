-- Proposer-verifier resumability: persist per-candidate verification verdicts so a
-- quota/crash mid-verify never loses Gemini work. chunk_cache (already present) saves
-- the Qwen proposals; pv_verdicts saves the verify results, keyed by candidate index.
-- Both survive the /jobs/:id/retry reset, so a retry resumes without re-running Modal
-- or re-verifying already-checked candidates.

alter table jobs
  add column if not exists pv_verdicts jsonb;
