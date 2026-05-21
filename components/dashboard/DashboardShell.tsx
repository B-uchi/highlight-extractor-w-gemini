"use client";

import { usePathname, useRouter } from "next/navigation";
import { Menu, MessageSquarePlus, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConversationSidebarItem } from "@/components/dashboard/ConversationSidebarItem";
import type { ConversationRecord } from "@/lib/types";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationRecord[] | null>(null);
  const [archivedConversations, setArchivedConversations] = useState<ConversationRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const payload = (await res.json()) as {
        conversations?: ConversationRecord[];
        archived?: ConversationRecord[];
        error?: string;
      };
      if (!res.ok) {
        setError(payload.error ?? "Could not load conversations.");
        setConversations([]);
        setArchivedConversations([]);
        return;
      }
      setConversations(payload.conversations ?? []);
      setArchivedConversations(payload.archived ?? []);
      setError(null);
    } catch {
      setError("Could not load conversations.");
      setConversations([]);
      setArchivedConversations([]);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh, pathname]);

  const onConversationDeleted = (id: string) => {
    if (pathname === `/dashboard/${id}`) {
      router.push("/dashboard");
    }
    void refresh();
  };

  const onNewChat = async () => {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = (await res.json()) as { conversation?: ConversationRecord; error?: string };
    if (!res.ok || !payload.conversation) {
      setError(payload.error ?? "Could not create conversation.");
      return;
    }
    router.push(`/dashboard/${payload.conversation.id}`);
    setSidebarOpen(false);
  };

  const sidebar = (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
        <Video className="h-5 w-5 text-blue-400" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">Video Highlights</p>
          <p className="truncate text-xs text-zinc-500">Agent dashboard</p>
        </div>
      </div>

      <div className="p-2">
        <button
          type="button"
          onClick={() => void onNewChat()}
          className="flex w-full items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New conversation
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {error && (
          <div className="mb-2 rounded-lg border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-100">
            {error}
            <div className="mt-2 text-[11px] text-amber-200/80">
              Conversations require Postgres. Run{" "}
              <code className="rounded bg-black/30 px-1">docker compose up -d</code> and set{" "}
              <code className="rounded bg-black/30 px-1">USE_DATABASE_JOBS=true</code> with{" "}
              <code className="rounded bg-black/30 px-1">DATABASE_URL</code>.
            </div>
          </div>
        )}
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent</p>
        <ul className="space-y-1">
          {(conversations ?? []).map((c) => (
            <li key={c.id}>
              <ConversationSidebarItem
                conversation={c}
                active={pathname === `/dashboard/${c.id}`}
                onUpdated={() => void refresh()}
                onDeleted={onConversationDeleted}
                onNavigate={() => setSidebarOpen(false)}
              />
            </li>
          ))}
        </ul>

        {archivedConversations.length > 0 && (
          <>
            <p className="mb-2 mt-4 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Archived
            </p>
            <ul className="space-y-1">
              {archivedConversations.map((c) => (
                <li key={c.id}>
                  <ConversationSidebarItem
                    conversation={c}
                    active={pathname === `/dashboard/${c.id}`}
                    archived
                    onUpdated={() => void refresh()}
                    onDeleted={onConversationDeleted}
                    onNavigate={() => setSidebarOpen(false)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex h-[100dvh] min-h-0 w-full bg-black text-zinc-100">
      <div className="hidden md:flex">{sidebar}</div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 h-full w-[min(20rem,85vw)] shadow-xl">{sidebar}</div>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/80 px-3 py-2 md:hidden">
          <button
            type="button"
            className="rounded-lg border border-zinc-800 p-2"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          <p className="text-sm font-semibold">Workspace</p>
        </header>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
