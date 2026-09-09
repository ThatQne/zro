(snapshot => {
  if (location.href !== snapshot.url) return;
  if (globalThis.__zroNewTabDocument && snapshot.arcade) {
    globalThis.__zroArcadeRestore?.(snapshot.arcade);
    scrollTo(snapshot.x || 0, snapshot.y || 0);
    return;
  }
  let stopped = false;
  const applied = new Set();
  const watched = new Map();
  const inputs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  const root = { document, location, scrollTo, addEventListener, removeEventListener, HTMLInputElement, HTMLTextAreaElement, Event };
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const w of watched.values()) for (const name of inputs) {
      try { w.removeEventListener(name, stop, true); } catch (_) {}
    }
    watched.clear();
  };
  function restoreDocument(w, saved, depth) {
    if (stopped || depth > 2 || w.location.href !== saved.url) return;
    const doc = w.document;
    if (!watched.has(doc)) {
      if (watched.size >= 24) { stop(); return; }
      watched.set(doc, w);
      for (const name of inputs) w.addEventListener(name, stop, { capture: true, once: true });
    }
    for (const field of saved.forms) {
      const el = field.path && doc.querySelector(field.path);
      if (!el || applied.has(el) || el.tagName !== field.tag || el.type !== field.type || el.name !== field.name) continue;
      if (field.selected) for (const option of el.options) option.selected = field.selected.includes(option.value);
      else if (/^(checkbox|radio)$/.test(field.type)) el.checked = field.checked;
      else {
        const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, field.value);
      }
      applied.add(el);
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    w.scrollTo(saved.x, saved.y);
    for (const item of saved.scrollers) {
      const el = item.path && doc.querySelector(item.path);
      if (el) { el.scrollLeft = item.x; el.scrollTop = item.y; }
    }
    for (const frame of saved.frames || []) {
      try {
        const el = doc.querySelector(frame.path);
        if (el?.contentWindow) restoreDocument(el.contentWindow, frame.state, depth + 1);
      } catch (_) {} // cross-origin navigation on wake: do not access/restore
    }
  }
  const restore = () => {
    if (stopped || location.href !== snapshot.url) { stop(); return; }
    try { restoreDocument(root, snapshot, 0); } catch (_) { stop(); }
  };
  const timer = setInterval(restore, 250);
  setTimeout(stop, 5000);
  restore();
})
