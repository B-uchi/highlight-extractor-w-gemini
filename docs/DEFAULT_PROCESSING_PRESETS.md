# Default processing presets

The dashboard **Processing presets** panel stores a multi-select checklist on each conversation (`player_focus_json.processingPresets`; same JSON column may also hold structured `playerFocus` from APIs or tooling — no separate migration).

Stable ids (`lib/defaultActions.ts`):

| id | Meaning |
| --- | --- |
| `player_identification` | Chunked identification / honesty about tracking limits |
| `highlight_events` | Breadth hint for plausible highlight classes |
| `team_highlight` | Team reel brief; substitutes `[Team Highlight Name]` when the field is set |
| `individual_player_highlight` | Player reel brief; `[Player Name]`, `[Jersey Number]` |
| `clip_quality_rules` | Watchability / pacing hygiene |
| `ranking_prompt` | Comparative scoring heuristic |
| `output_prompt` | Structure of titles, reasons, machine-parse hints |

When `start_processing` runs, or when `POST /api/process` includes multipart field `processingPresets` holding JSON `{ "selectedIds": [...], "placeholders"? }`, presets are flattened with `buildCombinedPrompt` **before** the user’s typed `prompt`. The merged string becomes `JobState.userPrompt` and flows into `rankVisualHighlights` as `Highlight criteria`.

**Merge order:** preset block · divider · chat “freeform” instructions (narrower tweaks last).

### Agent overrides

Optional tool shape on `start_processing`:

```json
{
  "processing_presets": {
    "selected_preset_ids": ["highlight_events"],
    "team_highlight_name": "Away squad",
    "primary_player_name": "Jamie",
    "primary_jersey_number": "3"
  }
}
```

Unset keys keep the dashboard copy. Passing `selected_preset_ids: []` clears presets **for that run only** without deleting saved conversation presets.

### Limitations

- **Refine** (`refine_highlights` / `runRefineHighlights`) replaces `userPrompt` with `new_prompt` only; presets are **not** re-appended unless you paste them manually.
- Transcript/audio caching keys still depend on hashed `userPrompt`; changing presets changes the downstream ranking cache segment (by design).
