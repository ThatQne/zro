(() => {
  const budget = { nodes: 10000, fields: 200, scrollers: 100, frames: 8 };
  const protect = () => { throw new Error('state requires live renderer'); };
  function capture(w, depth) {
  const doc = w.document; // cross-origin access throws: never discard opaque state
  if (!doc || (depth > 0 && doc.readyState !== 'complete') || depth > 2) protect();
  if (doc.querySelector('canvas, audio, video, [contenteditable]:not([contenteditable="false"])')) protect();
  const path = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== doc.documentElement) {
      const parent = el.parentElement;
      if (!parent) return null;
      parts.unshift(el.tagName.toLowerCase() + ':nth-child(' + (Array.prototype.indexOf.call(parent.children, el) + 1) + ')');
      el = parent;
    }
    return 'html>' + parts.join('>');
  };
  const forms = [];
  const controls = doc.querySelectorAll('input,textarea,select');
  if ((budget.fields -= controls.length) < 0) protect();
  for (const el of controls) {
    const check = /^(checkbox|radio)$/.test(el.type);
    const selected = el.tagName === 'SELECT' ? [...el.options].filter(o => o.selected).map(o => o.value) : null;
    const changed = selected ? [...el.options].some(o => o.selected !== o.defaultSelected)
      : check ? el.checked !== el.defaultChecked : el.value !== el.defaultValue;
    if (!changed) continue;
    // Keep these pages frozen rather than copying credentials/payment data.
    if (/password|file|hidden/.test(el.type) || /password|cc-|credit|card|cvc|cvv|otp|one-time|ssn/i.test([el.autocomplete, el.name, el.id].join(' '))) protect();
    if (!path(el)) protect();
    forms.push({ path: path(el), tag: el.tagName, type: el.type, name: el.name, value: el.value, checked: el.checked, selected });
  }
  const elements = doc.querySelectorAll('*');
  if ((budget.nodes -= elements.length) < 0) protect();
  const scrollers = [];
  for (const el of elements) {
    if (el.shadowRoot) protect(); // may contain drafts outside the light DOM
    if (el !== doc.documentElement && el !== doc.body && (el.scrollTop || el.scrollLeft)) {
      if (--budget.scrollers < 0 || !path(el)) protect();
      scrollers.push({ path: path(el), x: el.scrollLeft, y: el.scrollTop });
    }
  }
  const frames = [];
  for (const frame of doc.querySelectorAll('iframe,frame')) {
    if (--budget.frames < 0 || !path(frame)) protect();
    frames.push({ path: path(frame), state: capture(frame.contentWindow, depth + 1) });
  }
  return { url: w.location.href, x: w.scrollX, y: w.scrollY, forms, scrollers, frames };
  }
  try {
    if (globalThis.__zroNewTabDocument && typeof globalThis.__zroArcadeSave === 'function') {
      const snapshot = { url: location.href, x: scrollX, y: scrollY, forms: [], scrollers: [], frames: [], arcade: globalThis.__zroArcadeSave() };
      return JSON.stringify(snapshot).length > 32768 ? { protected: true } : snapshot;
    }
    const snapshot = capture({ document, location, scrollX, scrollY }, 0);
    return JSON.stringify(snapshot).length > 32768 ? { protected: true } : snapshot;
  } catch (_) { return { protected: true }; }
})()
