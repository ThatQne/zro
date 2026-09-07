(snapshot => {
  if (location.href !== snapshot.url) return;
  let stopped = false;
  const applied = new Set();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) removeEventListener(name, stop, true);
  };
  const restore = () => {
    if (stopped || location.href !== snapshot.url) { stop(); return; }
    for (const field of snapshot.forms) {
      const el = field.path && document.querySelector(field.path);
      if (!el || applied.has(el) || el.tagName !== field.tag || el.type !== field.type || el.name !== field.name) continue;
      if (field.selected) for (const option of el.options) option.selected = field.selected.includes(option.value);
      else if (/^(checkbox|radio)$/.test(field.type)) el.checked = field.checked;
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, field.value);
      }
      applied.add(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scrollTo(snapshot.x, snapshot.y);
    for (const item of snapshot.scrollers) {
      const el = item.path && document.querySelector(item.path);
      if (el) { el.scrollLeft = item.x; el.scrollTop = item.y; }
    }
  };
  const timer = setInterval(restore, 250);
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(name, stop, { capture: true, once: true });
  setTimeout(stop, 5000);
  restore();
})
