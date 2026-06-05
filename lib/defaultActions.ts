export const PROCESSING_ACTION_IDS = [
  "player_identification",
  "highlight_events",
  "team_highlight",
  "individual_player_highlight",
] as const;

export type ProcessingActionId = (typeof PROCESSING_ACTION_IDS)[number];

export interface DefaultProcessingActionDefinition {
  id: ProcessingActionId;
  title: string;
  description: string;
  promptTemplate: string;
}

/**
 * Default processing actions — prompt text matches the product brief verbatim (see docs).
 * Substitution: `Triple Threat Athletics`, `[Player Name]`, `[Number]`, `[Jersey Number]`, `[Team Name]`, `[jersey color]` when preset fields are set.
 */
export const DEFAULT_PROCESSING_ACTIONS: DefaultProcessingActionDefinition[] = [
  {
    id: "player_identification",
    title: "Player Identification Prompt",
    description:
      "Full-game identity brief, required/optional inputs, and example line.",
    promptTemplate: `Find and track Player [JERSEY_NUMBER] on the [JERSEY_COLOR] jersey/uniform. Isolate all possessions where [JERSEY_NUMBER] is involved in the play, including scoring, assists, rebounds, steals, blocks, defensive stops, ball handling, and transition plays.`,
  },
  {
    id: "highlight_events",
    title: "Highlight Event Detection Prompt",
    description: "Basketball events where the player makes a positive impact.",
    promptTemplate: `Create a highlight reel for each player by detecting basketball events where the player makes a positive impact.

Events to pull:

Made 3-point shots
Made jump shots
Layups
Finishes through contact
Dunks
Assists
Hockey assists / pass leading to score
Rebounds
Steals
Blocks
Defensive stops
Deflections
Fast breaks
Ball handling / breakdowns
Good passes
Hustle plays
Charges taken
And-1 plays`,
  },
  {
    id: "team_highlight",
    title: "Team-Based Highlight Prompt",
    description:
      "Team film brief; preset “Team name” replaces Triple Threat Athletics when filled.",
    promptTemplate: `Prompt:

"Create a team highlight film for Triple Threat Athletics, Jersey color [Jersey Color]. Prioritize clips where our team scores, forces turnovers, gets stops, moves the ball well, plays in transition, or shows high-energy team basketball."`,
  },
  {
    id: "individual_player_highlight",
    title: "Individual Player Highlight Prompt",
    description:
      "panel fields substitute [Player Name], #[Number], [Team Name], [jersey color].",
    promptTemplate: `Prompt:

"Create a highlight video for [Player Name], jersey #[Number], on [Team Name], wearing [jersey color]. Pull only positive plays where this player is clearly involved. Include 1 second before the play develops and 2 seconds after the play ends."`,
  },
];
