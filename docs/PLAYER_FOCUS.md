# Player / team targeting

The product **cannot yet** do everything in a “full-game player identification + tracking” brief (persistent IDs through occlusions, both ends of the court, off-ball identity) **without** dedicated computer vision (detectors, trackers, jersey OCR, re-ID). That is the roadmap in `next.md` Phase 2.

What **does** ship in this repo today:

1. **Structured `PlayerFocusSpec`** on each job (`teamAName`, `jerseyColors`, `roster[]`, `identificationPrompt`, `primaryTarget`).
2. **Gemini chunk prompts** get a long “targeting” block that:
   - prioritizes clips where numbers / kit colors are visible,
   - asks for optional output fields: `playerJersey`, `playerName`, `teamTag`, `visibilityNote` on each highlight,
   - states chunk-level limitations honestly (no guaranteed cross-chunk identity).
3. **Dashboard chat / agent**: freeform roster and jersey cues in conversation are folded into `start_processing` alongside saved presets when the intent is obvious (same merge path as tooling). Programmatic saves still use `POST /api/conversations/:id/targeting` (`playerFocus` optional).
4. **Direct upload API**: multipart field `playerFocus` (JSON string) on `POST /api/process`.

### Example JSON

```json
{
  "teamAName": "Triple Threat Athletics",
  "jerseyColors": ["black", "white trim"],
  "identificationPrompt": "Scan for Team A players using jersey color, numbers, and roster names. When numbers are unclear, say so in visibilityNote.",
  "roster": [
    {
      "jerseyNumber": "3",
      "displayName": "Bryn Amiwero",
      "accessoryNotes": "bright shoes"
    }
  ],
  "primaryTarget": {
    "jerseyNumber": "3",
    "isolationPrompt": "All possessions where #3 is clearly involved: scoring, assists, rebounds, steals, blocks, stops, handling, transition."
  }
}
```

### Migration

Conversations store pending targeting in `player_focus_json`. Apply:

```bash
psql "$DATABASE_URL" -f drizzle/0002_conversation_player_focus.sql
```
