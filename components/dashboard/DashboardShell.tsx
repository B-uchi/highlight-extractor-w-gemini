"use client";

import { usePathname, useRouter } from "next/navigation";
import { Menu, MessageSquarePlus, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { ConversationSidebarItem } from "@/components/dashboard/ConversationSidebarItem";
import type { Conversation } from "@/lib/types";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [archived, setArchived] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const payload = (await res.json()) as {
        conversations?: Conversation[];
        archived?: Conversation[];
        error?: string;
      };
      if (!res.ok) {
        setError(payload.error ?? "Could not load conversations.");
        setConversations([]);
        setArchived([]);
        return;
      }
      setConversations(payload.conversations ?? []);
      setArchived(payload.archived ?? []);
      setError(null);
    } catch {
      setError("Could not load conversations.");
      setConversations([]);
      setArchived([]);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void refresh(); });
  }, [refresh, pathname]);

  const onNewChat = async () => {
    const res = await fetch("/api/conversations", { method: "POST" });
    const payload = (await res.json()) as { conversation?: { id: string }; error?: string };
    if (!res.ok || !payload.conversation) {
      setError(payload.error ?? "Could not create conversation.");
      return;
    }
    router.push(`/dashboard/${payload.conversation.id}`);
    setSidebarOpen(false);
  };

  const sidebar = (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <Link href="/dashboard">
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <Video className="h-5 w-5 text-blue-400" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-100">Video Highlights</p>
            <p className="truncate text-xs text-zinc-500">Agent dashboard</p>
          </div>
        </div>
      </Link>

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
          </div>
        )}

        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Recent
        </p>
        <ul className="space-y-1">
          {(conversations ?? []).map((c) => (
            <li key={c.id}>
              <ConversationSidebarItem
                conversation={c}
                active={pathname === `/dashboard/${c.id}`}
                onUpdated={() => void refresh()}
                onNavigate={() => setSidebarOpen(false)}
              />
            </li>
          ))}
        </ul>

        {archived.length > 0 && (
          <>
            <p className="mb-2 mt-4 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Archived
            </p>
            <ul className="space-y-1">
              {archived.map((c) => (
                <li key={c.id}>
                  <ConversationSidebarItem
                    conversation={c}
                    active={pathname === `/dashboard/${c.id}`}
                    archived
                    onUpdated={() => void refresh()}
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
          <div className="relative z-50 h-full w-[min(20rem,85vw)] shadow-xl">
            {sidebar}
          </div>
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
