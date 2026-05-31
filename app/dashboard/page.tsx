"use client";

import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

export default function DashboardHomePage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const payload = (await res.json()) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !payload.conversation) {
        setError(payload.error ?? "Could not create a conversation.");
        return;
      }
      router.push(`/dashboard/${payload.conversation.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-xl rounded-3xl border border-zinc-800 bg-zinc-950 p-8">
        <div className="flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-blue-400" />
          <h1 className="text-2xl font-semibold text-zinc-50">Welcome</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Start a conversation, upload a basketball game video, and ask for specific highlights —
          dunks, blocks, player reels, team compilations, and more. Powered by Gemini.
        </p>

        {error && (
          <div className="mt-4 rounded-xl border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-100">
            {error}
          </div>
        )}

        <div className="mt-8">
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60 transition-colors"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Start a conversation
          </button>
        </div>
      </div>
    </div>
  );
}
