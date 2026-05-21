import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
import { normalizeProcessingPresetsState } from "@/lib/defaultActions";
import { parsePlayerFocusSpec } from "@/lib/playerFocus";
import type { ProcessingPresetsState } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const existing = await getConversation(id);
    if (!existing) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    const body = (await request.json()) as {
      playerFocus?: unknown;
      processingPresets?: unknown;
    };

    const touchesPlayerFocus = Object.prototype.hasOwnProperty.call(body, "playerFocus");
    const touchesPresets = Object.prototype.hasOwnProperty.call(body, "processingPresets");

    if (!touchesPlayerFocus && !touchesPresets) {
      return NextResponse.json(
        { error: "Expected `playerFocus` and/or `processingPresets` in JSON body." },
        { status: 400 },
      );
    }

    const patch: Parameters<typeof updateConversation>[1] = {};

    if (touchesPlayerFocus) {
      if (body.playerFocus === null || body.playerFocus === undefined) {
        patch.playerFocus = null;
      } else {
        const spec = parsePlayerFocusSpec(body.playerFocus);
        if (!spec) {
          return NextResponse.json(
            {
              error:
                "Invalid playerFocus. Required field: teamAName (string). Optional: jerseyColors, roster, ...",
            },
            { status: 400 },
          );
        }
        patch.playerFocus = spec;
      }
    }

    if (touchesPresets) {
      if (body.processingPresets === null) {
        patch.processingPresets = null;
      } else if (typeof body.processingPresets === "object" && body.processingPresets !== null) {
        patch.processingPresets =
          normalizeProcessingPresetsState(body.processingPresets as ProcessingPresetsState) ?? null;
      } else {
        return NextResponse.json({ error: "processingPresets must be an object or null." }, { status: 400 });
      }
    }

    const updated = await updateConversation(id, patch);
    return NextResponse.json({ conversation: updated });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
