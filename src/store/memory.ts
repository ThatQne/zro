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
  loaded: boolean;
  busy: boolean;
  load: () => Promise<void>;
  add: (input: AddInput) => Promise<MemNode | null>;
  update: (id: string, patch: Partial<Pick<MemNode, "title" | "body" | "done" | "pinned" | "tags">>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  link: (a: string, b: string) => Promise<void>;
  unlink: (a: string, b: string) => Promise<void>;
  search: (q: string) => Promise<{ id: string; score: number }[]>;
}

async function refetch(): Promise<{ nodes: MemNode[]; edges: MemEdge[] }> {
  const g = await invoke<{ nodes: MemNode[]; edges: MemEdge[] }>("mem_list");
  return { nodes: g.nodes || [], edges: g.edges || [] };
}

export const useMemoryStore = create<MemState>((set, get) => ({
  nodes: [],
  edges: [],
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
    set({ busy: true });
    try {
      const node = await invoke<MemNode>("mem_add", {
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        url: input.url ?? null,
        image: input.image ?? null,
      });
      // Auto-link may have created edges — pull the fresh graph.
      const g = await refetch();
      set({ nodes: g.nodes, edges: g.edges, busy: false });
      return node;
    } catch {
      set({ busy: false });
      return null;
    }
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
    await invoke("mem_delete", { id }).catch(() => {});
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.a !== id && e.b !== id),
    }));
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

/** Fire-and-forget: record a visited page as a graph node (deduped by URL). */
export function ingestVisit(url: string, title: string) {
  if (!url || url.startsWith("about:") || url.startsWith("zro:")) return;
  invoke("mem_ingest_visit", { url, title }).catch(() => {});
}
