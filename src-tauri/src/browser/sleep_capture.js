(() => {
  // Rich editors have application-owned state that cannot be serialized as form fields.
  if (document.querySelector('canvas, iframe, frame, [contenteditable]:not([contenteditable="false"])')) return { protected: true };
  const path = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== document.documentElement) {
      const parent = el.parentElement;
      if (!parent) return null;
      parts.unshift(el.tagName.toLowerCase() + ':nth-child(' + (Array.prototype.indexOf.call(parent.children, el) + 1) + ')');
      el = parent;
    }
    return 'html>' + parts.join('>');
  };
  const forms = [];
  const controls = [...document.querySelectorAll('input,textarea,select')];
  if (controls.length > 200) return { protected: true };
  for (const el of controls) {
    const check = /^(checkbox|radio)$/.test(el.type);
    const selected = el.tagName === 'SELECT' ? [...el.options].filter(o => o.selected).map(o => o.value) : null;
    const changed = selected ? [...el.options].some(o => o.selected !== o.defaultSelected)
      : check ? el.checked !== el.defaultChecked : el.value !== el.defaultValue;
    if (!changed) continue;
    // Keep these pages frozen rather than copying credentials/payment data.
    if (/password|file|hidden/.test(el.type) || /password|cc-|credit|card|cvc|cvv|otp|one-time|ssn/i.test([el.autocomplete, el.name, el.id].join(' '))) return { protected: true };
    forms.push({ path: path(el), tag: el.tagName, type: el.type, name: el.name, value: el.value, checked: el.checked, selected });
  }
  const elements = [...document.querySelectorAll('*')];
  if (elements.length > 10000) return { protected: true };
  const scrollers = elements.filter(el => el !== document.documentElement && el !== document.body && (el.scrollTop || el.scrollLeft))
    .slice(0, 100).map(el => ({ path: path(el), x: el.scrollLeft, y: el.scrollTop }));
  const snapshot = { url: location.href, x: scrollX, y: scrollY, forms, scrollers };
  return JSON.stringify(snapshot).length > 32768 ? { protected: true } : snapshot;
})()
