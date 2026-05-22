# Default processing presets

The dashboard **Processing actions** panel is a multi-select checklist on each conversation (`player_focus_json.processingPresets`; the same JSON column may also hold structured `playerFocus` from APIs or tooling — no separate migration). **Confirm** merges the selected prompts into the chat box and saves the selection here for `start_processing` / refine.

Stable ids (`lib/defaultActions.ts`):

| id | Meaning |
| --- | --- |
| `player_identification` | Verbatim identification brief + inputs + example (from product spec) |
| `highlight_events` | Basketball-positive-event list (verbatim) |
| `team_highlight` | Team film prompt; **Team name** field replaces **Triple Threat Athletics** in that preset block only |
| `individual_player_highlight` | Individual reel prompt; fields substitute `[Player Name]`, `[Number]` / `#[Number]`, `[Team Name]`, `[jersey color]` |
| `clip_quality_rules` | Clip filtering rules (verbatim) |
| `ranking_prompt` | Rank order (verbatim) |
| `output_prompt` | Export/label brief + Bryn Amiwero example lines (verbatim) |

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
    "primary_jersey_number": "3",
    "individual_team_name": "Triple Threat Athletics",
    "jersey_color": "black"
  }
}
```

Unset keys keep the dashboard copy. Passing `selected_preset_ids: []` clears presets **for that run only** without deleting saved conversation presets.

### Limitations

- **Refine** (`refine_highlights` / `runRefineHighlights`) replaces `userPrompt` with `new_prompt` only; presets are **not** re-appended unless you paste them manually.
- Transcript/audio caching keys still depend on hashed `userPrompt`; changing presets changes the downstream ranking cache segment (by design).
