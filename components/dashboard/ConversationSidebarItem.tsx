"use client";

import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { Conversation } from "@/lib/types";
import { relativeTime } from "@/lib/format";

type Props = {
  conversation: Conversation;
  active: boolean;
  archived?: boolean;
  onUpdated: () => void;
  onNavigate?: () => void;
};

export function ConversationSidebarItem({
  conversation,
  active,
  archived = false,
  onUpdated,
  onNavigate,
}: Props) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRenameValue(conversation.title);
  }, [conversation.title]);

  useEffect(() => {
    if (!menuOpen) { setConfirmDelete(false); return; }
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const patch = async (body: { title?: string; archived?: boolean }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return false;
      onUpdated();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const onRenameSubmit = async () => {
    const title = renameValue.trim();
    if (!title || title === conversation.title) {
      setIsRenaming(false);
      setRenameValue(conversation.title);
      return;
    }
    const ok = await patch({ title });
    if (ok) setIsRenaming(false);
  };

  const onArchiveToggle = async () => {
    setMenuOpen(false);
    await patch({ archived: !archived });
  };

  const onDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setMenuOpen(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      if (res.ok) {
        onUpdated();
        if (active) router.push("/dashboard");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={["group relative rounded-lg", active ? "bg-zinc-900" : "hover:bg-zinc-900/70"].join(" ")}>
      {isRenaming ? (
        <form
          className="px-3 py-2"
          onSubmit={(e) => { e.preventDefault(); void onRenameSubmit(); }}
        >
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => void onRenameSubmit()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsRenaming(false);
                setRenameValue(conversation.title);
              }
            }}
            disabled={busy}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
        </form>
      ) : (
        <>
          <Link
            href={`/dashboard/${conversation.id}`}
            onClick={onNavigate}
            className={["block px-3 py-2 pr-9 text-sm", active ? "text-zinc-50" : "text-zinc-300"].join(" ")}
          >
            <span className="line-clamp-2 font-medium">{conversation.title}</span>
            <span className="mt-0.5 block text-[11px] text-zinc-500">
              {relativeTime(conversation.updated_at)}
            </span>
          </Link>

          <div ref={menuRef} className="absolute right-1 top-1">
            <button
              type="button"
              aria-label="Options"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((o) => !o); }}
              className={[
                "rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              ].join(" ")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-900"
                  onClick={() => { setMenuOpen(false); setIsRenaming(true); }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-900"
                  onClick={() => void onArchiveToggle()}
                >
                  {archived ? (
                    <><ArchiveRestore className="h-3.5 w-3.5" />Unarchive</>
                  ) : (
                    <><Archive className="h-3.5 w-3.5" />Archive</>
                  )}
                </button>
                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  className={[
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-900",
                    confirmDelete ? "text-red-400 font-medium" : "text-zinc-400",
                  ].join(" ")}
                  onClick={() => void onDelete()}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  {confirmDelete ? "Confirm delete?" : "Delete"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
