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

  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [onclick]';

  function labelFor(el) {
    if (!el?.getAttribute) return '';
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 100);
    if (el.labels && el.labels[0]) return clip(el.labels[0].innerText, 100);
    const hint = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt');
    if (hint) return clip(hint, 100);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.name || '';
    const text = clip(el.innerText || el.textContent, 400);
    // A whole block of page text is not the name of what was clicked.
    if (text) return text.length <= 100 || el.matches(INTERACTIVE) ? clip(text, 100) : '';
    // Icon and picture controls carry their name on a child.
    const inner = el.querySelector('img[alt]:not([alt=""]), [aria-label], [title]');
    return clip(inner?.getAttribute('alt') || inner?.getAttribute('aria-label') || inner?.getAttribute('title')
      || el.querySelector('svg title')?.textContent, 100);
  }

  // Something without a name of its own: say which list item or card it sits in.
  function nearText(el) {
    const box = el.closest?.('li, article, tr, figure, [role="listitem"], [role="row"], [role="article"]');
    const text = box ? clip(box.innerText, 300) : '';
    return text && text.length <= 300 ? clip(text, 80) : '';
  }

  function describe(el) {
    const label = labelFor(el);
    return {
      tag: el.tagName?.toLowerCase(),
      type: el.getAttribute?.('type') || undefined,
      role: el.getAttribute?.('role') || undefined,
      label,
      near: label ? undefined : nearText(el) || undefined,
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

  const NOT_TEXT = ['checkbox', 'radio', 'submit', 'button', 'file'];

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? (e.target.closest(INTERACTIVE) || e.target) : null;
    // A click on the page background is not an action.
    if (!el || el === document.documentElement || el === document.body) return;
    // Text inputs: the "change" event below is more useful than the click.
    if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) return;
    if (el.tagName === 'TEXTAREA') return;
    send({ kind: 'click', target: describe(el) });
  }, true);

  function valueOf(el) {
    if (isSensitive(el)) return '[REDACTED]';
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : 'unchecked';
    if (el.tagName === 'SELECT') return clip(el.options[el.selectedIndex]?.text);
    if (el.type === 'file') return `[${el.files?.length || 0} file(s)]`;
    return clip(el.value);
  }

  const lastSent = new WeakMap();  // field -> the value last recorded for it
  const viaEnter = new WeakSet();  // fields whose last value was recorded by the Enter key

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const value = valueOf(el);
    // Enter already recorded this value (see keydown): the browser only fires "change" afterwards.
    const repeat = viaEnter.has(el) && lastSent.get(el) === value;
    viaEnter.delete(el);
    if (repeat) return;
    lastSent.set(el, value);
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
    // What was typed comes before the Enter that sends it, so the log reads in order.
    if (!NOT_TEXT.includes(el.type)) {
      const value = valueOf(el);
      if (value && lastSent.get(el) !== value) {
        lastSent.set(el, value);
        viaEnter.add(el);
        send({ kind: 'input', target: describe(el), value });
      }
    }
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
