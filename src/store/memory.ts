import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Graph memory mirror. The Rust side (browser/memory.rs) owns persistence,
// embeddings, and auto-linking; this store is a thin cache + command wrapper
// so any surface (the panel, a future right-click "save to memory") can write
// without the panel being open.

export type MemKind = "note" | "todo" | "link" | "image" | "clip" | "visit";
export type EdgeKind = "manual" | "semantic" | "domain" | "temporal";

export interface MemNode {
  id: string;
  kind: MemKind;
  title: string;
  body: string;
  url?: string | null;
  image?: string | null;
  created: number;
  updated: number;
  done: boolean;
  pinned: boolean;
  visits: number;
  tags: string[];
  linked: boolean; // has an embedding (semantic links possible)
}

export interface MemEdge {
  a: string;
  b: string;
  kind: EdgeKind;
  weight: number;
}

export interface AddInput {
  kind: MemKind;
  title: string;
  body?: string;
  url?: string | null;
  image?: string | null;
}

interface MemState {
  nodes: MemNode[];
  edges: MemEdge[];
  trash: MemNode[]; // session-only undo buffer for deleted nodes
  loaded: boolean;
  busy: boolean;
  load: () => Promise<void>;
  add: (input: AddInput) => Promise<MemNode | null>;
  update: (id: string, patch: Partial<Pick<MemNode, "title" | "body" | "done" | "pinned" | "tags">>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  recover: (id: string) => Promise<void>;
  link: (a: string, b: string) => Promise<void>;
  unlink: (a: string, b: string) => Promise<void>;
  search: (q: string) => Promise<{ id: string; score: number }[]>;
  refresh: () => Promise<void>;
}

async function refetch(): Promise<{ nodes: MemNode[]; edges: MemEdge[] }> {
  const g = await invoke<{ nodes: MemNode[]; edges: MemEdge[] }>("mem_list");
  return { nodes: g.nodes || [], edges: g.edges || [] };
}

export const useMemoryStore = create<MemState>((set, get) => ({
  nodes: [],
  edges: [],
  trash: [],
  loaded: false,
  busy: false,

  load: async () => {
    try {
      const g = await refetch();
      set({ nodes: g.nodes, edges: g.edges, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  add: async (input) => {
    try {
      // Backend returns instantly (no embedding on the hot path); it embeds +
      // auto-links in the background and fires `zro:mem-changed` when edges land.
      const node = await invoke<MemNode>("mem_add", {
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        url: input.url ?? null,
        image: input.image ?? null,
      });
      // Optimistic insert — no refetch round-trip.
      set((s) => ({ nodes: [node, ...s.nodes] }));
      return node;
    } catch {
      return null;
    }
  },

  refresh: async () => {
    try {
      const g = await refetch();
      set({ nodes: g.nodes, edges: g.edges });
    } catch { /* keep current */ }
  },

  update: async (id, patch) => {
    await invoke("mem_update", {
      id,
      title: patch.title ?? null,
      body: patch.body ?? null,
      done: patch.done ?? null,
      pinned: patch.pinned ?? null,
      tags: patch.tags ?? null,
    }).catch(() => {});
    const g = await refetch();
    set({ nodes: g.nodes, edges: g.edges });
  },

  remove: async (id) => {
    // Keep a copy in the session trash so a delete can be undone. The backend
    // delete is real; recovery re-adds the node (fresh id, auto re-links).
    const node = get().nodes.find((n) => n.id === id) || null;
    await invoke("mem_delete", { id }).catch(() => {});
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.a !== id && e.b !== id),
      trash: node ? [node, ...s.trash].slice(0, 12) : s.trash,
    }));
  },

  recover: async (id) => {
    const node = get().trash.find((n) => n.id === id);
    if (!node) return;
    set((s) => ({ trash: s.trash.filter((n) => n.id !== id) }));
    await get().add({ kind: node.kind, title: node.title, body: node.body, url: node.url, image: node.image });
  },

  link: async (a, b) => {
    await invoke("mem_link", { a, b }).catch(() => {});
    const g = await refetch();
    set({ nodes: g.nodes, edges: g.edges });
  },

  unlink: async (a, b) => {
    await invoke("mem_unlink", { a, b }).catch(() => {});
    set((s) => ({ edges: s.edges.filter((e) => !((e.a === a && e.b === b) || (e.a === b && e.b === a))) }));
  },

  search: async (q) => {
    if (!q.trim()) return [];
    try {
      return await invoke<{ id: string; score: number }[]>("mem_search", { query: q });
    } catch {
      return [];
    }
  },
}));
