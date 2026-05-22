/**
 * Walk fetch / Node networking errors that surface as AggregateError chains.
 */

function walkErrorLikeNodes(error: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!error || typeof error !== "object") {
    return;
  }
  const node = error as Record<string, unknown>;
  visit(node);
  walkErrorLikeNodes(node.cause, visit);
  if (Array.isArray(node.errors)) {
    for (const sub of node.errors) {
      walkErrorLikeNodes(sub, visit);
    }
  }
}

export function collectsConnectionRefusedPorts(error: unknown): number[] {
  const ports = new Set<number>();
  walkErrorLikeNodes(error, (node) => {
    if (node.code === "ECONNREFUSED" && typeof node.port === "number") {
      ports.add(node.port);
    }
  });
  return [...ports].sort((a, b) => a - b);
}

export function isLikelyFetchConnectionFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  if (!error.message.includes("fetch failed")) {
    return false;
  }
  return collectsConnectionRefusedPorts(error).length > 0;
}

function mentionsCannotReachCvWorker(message: string): boolean {
  return message.includes("Cannot reach CV worker");
}

/** Extra context when `fetch failed` is not already explained by CV client. */
export function describeGenericFetchTransportHint(error: unknown): string | undefined {
  const base = error instanceof Error ? error : null;
  if (!base?.message.includes("fetch failed")) {
    return undefined;
  }
  if (mentionsCannotReachCvWorker(base.message)) {
    return undefined;
  }

  const ports = collectsConnectionRefusedPorts(base);
  const refusedList = ports.length > 0 ? ` (connect refused on ${ports.join(", ")})` : "";

  let hint =
    `Network transport error${refusedList}. This is usually not a Gemini/OpenAI billing issue — check offline mode, firewall, VPN, or HTTP_PROXY/HTTPS_PROXY/` +
    `ALL_PROXY routing to an unreachable localhost address.`;

  if (ports.includes(8000)) {
    hint += ` Port 8000 is the Python CV worker; ensure \`ENABLE_CV_WORKER=true\` only when \`npm run dev\`'s CV process is running, or disable with ENABLE_CV_WORKER=false.`;
  }

  return hint;
}
