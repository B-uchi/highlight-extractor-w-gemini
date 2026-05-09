## Phase 1 — “Usable Basketball MVP” (1–2 weeks)

Goal: get reliable team/player-ish highlights quickly without deep CV infra.

- **Input schema**
  - Team name, opponent name
  - Jersey primary color(s)
  - Optional target player fields: `name`, `number`, `headshot`
- **Pipeline**
  - Keep current audio + Gemini visual highlight extraction.
  - Add basketball-specific prompt templates (team reel, player reel).
  - Add strict clip rules from your spec:
    - include `+1s` before, `+2s` after
    - remove dead time / inbound delays
- **Output structure**
  - `eventType`, `timestamp`, `score`, `reason`, `teamTag` (`us/them/unknown`)
- **What works**
  - Team-level highlights: scores, momentum plays, transitions.
  - Coarse player requests (“focus on #3”) when jersey is visible.
- **Known limits**
  - No robust long-horizon tracking through occlusions.
  - Event labels are LLM-inferred, not detector-grade.

Success metric:
- 70%+ “acceptable” clips by coach/manual review for team highlight reels.

---

## Phase 2 — “Player Tracking + Event Reliability” (3–6 weeks)

Goal: make player-specific reels trustworthy.

- **Detection + tracking**
  - Add person detector + tracker:
    - detector: YOLOv8/RT-DETR
    - tracker: ByteTrack or BoT-SORT
  - Track IDs across frames/camera pans.
- **Player identity layer**
  - Jersey number OCR on cropped player ROIs.
  - Jersey color classifier.
  - Optional face/headshot re-ID boost.
  - Resolve identity confidence: `playerIdConfidence`.
- **Event engine**
  - Build timeline features:
    - shot attempt / make proxy
    - rebound contest
    - steal/block candidate moments
    - transition segments
  - Keep Gemini as semantic referee for ambiguous events.
- **Ranking + filtering**
  - Implement your ranking order in code (not just prompt).
  - Add hard quality gates:
    - player visibility threshold
    - identity confidence threshold
    - positive-play filter
- **Output**
  - Per-player reels with `event`, `confidence`, `identityConfidence`, `clipQuality`.

Success metric:
- 80–90% correct player attribution on sampled clips.
- 75%+ event label precision for key events (3PT, assist, steal, block, rebound).

---

## Phase 3 — “Production Basketball Intelligence” (6–12+ weeks)

Goal: high-quality automated reels at scale for teams and players.

- **Basketball domain models**
  - Train/fine-tune event classifiers on your own labeled game data:
    - and-1, hockey assist, defensive stop, hustle play, charge taken.
- **Court/context intelligence**
  - Court keypoint detection (half-court side, basket orientation).
  - Possession segmentation and play-phase detection.
- **Advanced identity**
  - Multi-camera robustness (if available).
  - Better occlusion recovery + track re-linking.
- **Coach-grade outputs**
  - Reel presets:
    - Player 60–90s
    - Team game recap
    - Defensive-only reel
    - Transition-only reel
  - Export with metadata bundle (`JSON + MP4 + CSV`).
- **Product + ops**
  - Queue workers, retries, artifact lifecycle, cost controls.
  - Human review UI (approve/reject clips) feeding active learning loop.

Success metric:
- >90% coach acceptance with minimal edits.
- Reliable per-player reels generated automatically after each game.

---

## Recommended build order (practical)

1. Ship Phase 1 fast (you already have much of the plumbing).
2. Start Phase 2 with **tracking + jersey OCR** first (highest leverage).
3. Use Phase 2 reviewed clips as labeled data to unlock Phase 3 training.

If you want, next I can turn this into a **task-by-task sprint board** with exact files/modules for your current repo (backend + worker split, model services, DB tables, and QA checklist).