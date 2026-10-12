// ShowOnce content script: records what the user does on the page.
// Sensitive values (passwords, card numbers, tokens, CPF...) are never recorded.
(() => {
  if (window.__showonceLoaded) return;
  window.__showonceLoaded = true;

  const SENSITIVE = /pass|senha|cvv|cvc|card|cart[aã]o|cpf|cnpj|ssn|token|secret|otp|2fa|\bpin\b|iban|account.?number/i;
  const MAX_TEXT = 300;
  let recording = false;

  chrome.storage.local.get('recording').then(({ recording: r }) => { recording = !!r; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recording) recording = !!changes.recording.newValue;
  });

  const clip = (s, n = MAX_TEXT) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  function isSensitive(el) {
    if (!el || !el.getAttribute) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.startsWith('cc-') || ac.includes('password') || ac === 'one-time-code') return true;
    const hay = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
    return SENSITIVE.test(hay);
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      if (node.id && !/\d{4,}/.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const testId = node.getAttribute('data-testid');
      if (testId) { parts.unshift(`[data-testid="${testId}"]`); break; }
      let part = node.tagName.toLowerCase();
      const name = node.getAttribute('name');
      if (name) part += `[name="${name}"]`;
      else if (node.parentElement) {
        const same = [...node.parentElement.children].filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function labelFor(el) {
    if (!el) return '';
    const aria = el.getAttribute?.('aria-label');
    if (aria) return clip(aria, 100);
    if (el.labels && el.labels[0]) return clip(el.labels[0].innerText, 100);
    const ph = el.getAttribute?.('placeholder') || el.getAttribute?.('title') || el.getAttribute?.('alt');
    if (ph) return clip(ph, 100);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.name || '';
    return clip(el.innerText || el.textContent, 100);
  }

  function describe(el) {
    return {
      tag: el.tagName?.toLowerCase(),
      type: el.getAttribute?.('type') || undefined,
      role: el.getAttribute?.('role') || undefined,
      label: labelFor(el),
      selector: cssPath(el),
      href: el.href ? String(el.href) : undefined,
    };
  }

  function send(event) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({
        type: 'showonce:event',
        event: { ...event, url: location.href, title: document.title, ts: Date.now() },
      }).catch(() => {});
    } catch { /* extension reloaded */ }
  }

  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [onclick]';

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? (e.target.closest(INTERACTIVE) || e.target) : null;
    if (!el) return;
    // Text inputs: the "change" event below is more useful than the click.
    if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
    if (el.tagName === 'TEXTAREA') return;
    send({ kind: 'click', target: describe(el) });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    let value;
    if (isSensitive(el)) value = '[REDACTED]';
    else if (el.type === 'checkbox' || el.type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else if (el.tagName === 'SELECT') value = clip(el.options[el.selectedIndex]?.text);
    else if (el.type === 'file') value = `[${el.files?.length || 0} file(s)]`;
    else value = clip(el.value);
    send({ kind: 'input', target: describe(el), value });
  }, true);

  // contenteditable editors (Gmail compose, Notion, etc.)
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
    send({ kind: 'input', target: describe(el), value: isSensitive(el) ? '[REDACTED]' : clip(el.innerText) });
  }, true);

  document.addEventListener('submit', (e) => {
    send({ kind: 'submit', target: describe(e.target) });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const el = e.target;
    if (!(el instanceof Element) || !['INPUT'].includes(el.tagName)) return;
    send({ kind: 'key', key: 'Enter', target: describe(el) });
  }, true);

  document.addEventListener('copy', () => {
    const active = document.activeElement;
    const text = isSensitive(active) ? '[REDACTED]' : clip(String(window.getSelection() || ''), 500);
    if (text) send({ kind: 'copy', text });
  }, true);

  document.addEventListener('paste', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const raw = e.clipboardData?.getData('text') || '';
    send({ kind: 'paste', target: el ? describe(el) : undefined, text: isSensitive(el) ? '[REDACTED]' : clip(raw, 500) });
  }, true);
})();
