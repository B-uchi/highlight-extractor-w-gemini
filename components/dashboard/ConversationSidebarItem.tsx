"use client";

import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ConversationRecord } from "@/lib/types";

type ConversationSidebarItemProps = {
  conversation: ConversationRecord;
  active: boolean;
  archived?: boolean;
  onUpdated: () => void;
  onDeleted: (id: string) => void;
  onNavigate?: () => void;
};

export function ConversationSidebarItem({
  conversation,
  active,
  archived = false,
  onUpdated,
  onDeleted,
  onNavigate,
}: ConversationSidebarItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queueMicrotask(() => {
      setRenameValue(conversation.title);
    });
  }, [conversation.title]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const patchConversation = async (body: { title?: string; archived?: boolean }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return false;
      }
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
    const ok = await patchConversation({ title });
    if (ok) {
      setIsRenaming(false);
    }
  };

  const onArchiveToggle = async () => {
    setMenuOpen(false);
    await patchConversation({ archived: !archived });
  };

  const onDelete = async () => {
    setMenuOpen(false);
    const confirmed = window.confirm(
      `Delete "${conversation.title}"? This removes the conversation and its messages permanently.`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      if (res.ok) {
        onDeleted(conversation.id);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={[
        "group relative rounded-lg",
        active ? "bg-zinc-900" : "hover:bg-zinc-900/70",
      ].join(" ")}
    >
      {isRenaming ? (
        <form
          className="px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onRenameSubmit();
          }}
        >
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => void onRenameSubmit()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
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
            className={[
              "block px-3 py-2 pr-9 text-sm",
              active ? "text-zinc-50" : "text-zinc-300",
            ].join(" ")}
          >
            <span className="line-clamp-2 font-medium">{conversation.title}</span>
            <span className="mt-1 block text-[11px] text-zinc-500">
              {new Date(conversation.updatedAt).toLocaleString()}
            </span>
          </Link>

          <div ref={menuRef} className="absolute right-1 top-1">
            <button
              type="button"
              aria-label="Conversation options"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
              className={[
                "rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              ].join(" ")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-900"
                  onClick={() => {
                    setMenuOpen(false);
                    setIsRenaming(true);
                  }}
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
                    <>
                      <ArchiveRestore className="h-3.5 w-3.5" />
                      Unarchive
                    </>
                  ) : (
                    <>
                      <Archive className="h-3.5 w-3.5" />
                      Archive
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-400 hover:bg-zinc-900"
                  onClick={() => void onDelete()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
