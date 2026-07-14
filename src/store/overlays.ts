import { invoke } from "@tauri-apps/api/core";

// Central registry of DOM overlays that must render OVER the page webview.
// Each overlay (sidebar flyout, side panel, URL dropdown) reports its CSS-px
// rect; we push the union to Rust, which punches matching holes into the
// chrome region so the UI webview draws there instead of the page.

export interface OverlayRect { x: number; y: number; w: number; h: number; r: number }

const rects = new Map<string, OverlayRect>();
let raf = 0;

function flush() {
  raf = 0;
  const list = [...rects.values()];
  invoke("set_overlays", { rects: list }).catch(() => {});
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(flush);
}

/** Report (or update) an overlay's rect. Pass null to remove it. */
export function reportOverlay(id: string, rect: OverlayRect | null) {
  if (rect) rects.set(id, rect);
  else if (!rects.delete(id)) return;
  schedule();
}

/** Measure a DOM element and report it as an overlay; returns a cleanup fn. */
export function trackOverlay(id: string, el: HTMLElement | null, radius = 0): () => void {
  if (!el) return () => {};
  const measure = () => {
    const b = el.getBoundingClientRect();
    reportOverlay(id, { x: b.left, y: b.top, w: b.width, h: b.height, r: radius });
  };
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  window.addEventListener("resize", measure);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", measure);
    reportOverlay(id, null);
  };
}
