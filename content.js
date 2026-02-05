/**
 * Content script: capture right-clicked input, getPageInfo, applyValue, showFloatingMenu.
 * Also supports predictive field tracking to update context menu before right-click.
 */

const FORM_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/** Input types that are not editable (no storable text). Exclude from predictive tracking. */
const NON_EDITABLE_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden',
]);

/**
 * True if the element is an editable form field we might store values for.
 * Includes input, textarea, select, and contenteditable elements.
 */
function isEditableFormField(el) {
  if (!el) return false;
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return true;
  if (!FORM_TAGS.includes(el.tagName)) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute?.('type') || 'text').toLowerCase();
  return !NON_EDITABLE_INPUT_TYPES.has(type);
}

/** Get plain-text value from a field (input, textarea, select, or contenteditable). */
function getFieldValue(el) {
  if (!el) return '';
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
    return (el.innerText ?? el.textContent ?? '').trim();
  }
  if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.value ?? '';
  return el.value ?? '';
}

/** Set plain-text value on a field; dispatches input and change. */
function setFieldValue(el, v) {
  if (!el) return;
  const value = String(v ?? '');
  if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') {
    el.focus();
    el.innerText = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (el.tagName === 'SELECT') {
    const opt = Array.from(el.options).find((o) => o.value === value || o.text === value);
    if (opt) opt.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

let lastRightClickedElement = null;
let lastContextMenuX = 0;
let lastContextMenuY = 0;

// Predictive tracking state
let fieldTrackingEnabled = false;
let lastHoveredSelector = null;

// Inline field button for showing matches
const FIELD_BUTTON_ID = 'lazy-forms-field-button';
let fieldButtonTarget = null;
let fieldButtonResizeObserver = null;
/** When true, do not reposition the icon (e.g. while user has mouse down on it, so Jira spinner can't steal the click). */
let fieldButtonPositionFrozen = false;
/** Right edge of the visible (clipped) area for el. Only clamp when the field actually overflows its container. */
function getVisibleRightEdge(el) {
  const rect = el.getBoundingClientRect();
  let node = el.parentElement;
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    const overflow = s.overflowX || s.overflow || '';
    if (overflow === 'hidden' || overflow === 'clip' || overflow === 'scroll' || overflow === 'auto') {
      const r = node.getBoundingClientRect();
      // Only use container's right when the field actually extends past it (overflow); else use field's right
      const right = rect.right > r.right ? r.right : rect.right;
      return Math.min(right, window.innerWidth);
    }
    node = node.parentElement;
  }
  return Math.min(rect.right, window.innerWidth);
}

function positionFieldButton() {
  if (fieldButtonPositionFrozen) return;
  const btn = document.getElementById(FIELD_BUTTON_ID);
  if (!btn || !fieldButtonTarget) return;
  const rect = fieldButtonTarget.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) {
    btn.style.display = 'none';
    return;
  }
  const size = 18;
  const top = rect.top + (rect.height - size) / 2;
  // Use visible right edge so we don't place the icon past overflow:hidden/clip containers (e.g. Jira)
  let visibleRight = getVisibleRightEdge(fieldButtonTarget);
  // Account for field's padding-right (e.g. textareas) so the icon sits at the content edge, not over the padding
  const paddingRightPx = parseFloat(getComputedStyle(fieldButtonTarget).paddingRight) || 0;
  visibleRight -= paddingRightPx;
  const left = visibleRight - size;
  btn.style.display = 'flex';
  btn.style.top = `${Math.max(0, top)}px`;
  btn.style.left = `${Math.max(0, left)}px`;
}

function hideFieldButton() {
  if (fieldButtonResizeObserver) {
    fieldButtonResizeObserver.disconnect();
    fieldButtonResizeObserver = null;
  }
  const btn = document.getElementById(FIELD_BUTTON_ID);
  if (btn) {
    btn.remove();
  }
  fieldButtonTarget = null;
}

function startFieldButtonResizeObserving(el) {
  if (fieldButtonResizeObserver) fieldButtonResizeObserver.disconnect();
  const scheduleReposition = () => {
    if (fieldButtonTarget) positionFieldButton();
  };
  fieldButtonResizeObserver = new ResizeObserver(() => scheduleReposition());
  fieldButtonResizeObserver.observe(el);
  if (el.parentElement && el.parentElement !== document.body) {
    fieldButtonResizeObserver.observe(el.parentElement);
  }
}

function ensureFieldButton(el) {
  fieldButtonTarget = el;
  let btn = document.getElementById(FIELD_BUTTON_ID);
  if (!btn) {
    btn = document.createElement('button');
    btn.id = FIELD_BUTTON_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Show lazy forms values');
    btn.textContent = '≡';
    btn.style.position = 'fixed';
    btn.style.zIndex = '2147483647';
    btn.style.width = '18px';
    btn.style.height = '18px';
    btn.style.borderRadius = '50%';
    btn.style.border = 'none';
    btn.style.padding = '0';
    btn.style.margin = '0';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.cursor = 'pointer';
    btn.style.background = '#4a9eff';
    btn.style.color = '#fff';
    btn.style.fontSize = '11px';
    btn.style.lineHeight = '1';
    btn.style.boxShadow = '0 0 0 1px #fff, 0 2px 4px rgba(0,0,0,0.2)';

    // Freeze position on mousedown so sites (e.g. Jira) that change layout on click don't move the icon before click fires
    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      fieldButtonPositionFrozen = true;
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = fieldButtonTarget;
      if (!target) return;
      lastRightClickedElement = target;
      const selector = getStableSelector(target);
      const rect = target.getBoundingClientRect();
      const position = { x: rect.right, y: rect.bottom };
      try {
        chrome.runtime.sendMessage(
          {
            type: 'getFieldMatches',
            pageInfo: {
              url: location.href,
              origin: location.origin,
              pathname: location.pathname,
              selector,
            },
          },
          (reply) => {
            if (!reply || !reply.ok) return;
            const entries = reply.entries || [];
            showFloatingMenu(entries, position);
          }
        ).catch?.(() => {});
      } catch {
        // ignore errors (e.g. extension context invalidated)
      }
    });

    document.body.appendChild(btn);
  }
  startFieldButtonResizeObserving(el);
  positionFieldButton();
}

window.addEventListener(
  'scroll',
  () => {
    if (fieldButtonTarget) positionFieldButton();
  },
  true
);
window.addEventListener('resize', positionFieldButton);

// Unfreeze icon position on mouseup. Only reposition if the release was *not* on our button –
// otherwise Jira (etc.) may have changed layout and getBoundingClientRect() is wrong, sending the icon far right.
document.addEventListener(
  'mouseup',
  (e) => {
    if (!fieldButtonPositionFrozen) return;
    fieldButtonPositionFrozen = false;
    const btn = document.getElementById(FIELD_BUTTON_ID);
    const releasedOnOurButton = btn && (e.target === btn || btn.contains(e.target));
    if (!releasedOnOurButton) {
      requestAnimationFrame(() => {
        positionFieldButton();
      });
    }
  },
  true
);

document.addEventListener(
  'contextmenu',
  (e) => {
    const el = e.target;
    // If right-click was on a non–form-field (e.g. button, div), clear state so
    // menu actions don't use a stale field; next hover/focus on a field will send fieldHovered again
    if (!el || !isEditableFormField(el)) {
      lastHoveredSelector = null;
      lastRightClickedElement = null;
      return;
    }
    lastRightClickedElement = el;
    lastContextMenuX = e.clientX;
    lastContextMenuY = e.clientY;
    try {
      const selector = getStableSelector(el);
      const value = getFieldValue(el);
      chrome.runtime.sendMessage({
        type: 'contextMenuOpened',
        pageInfo: {
          url: location.href,
          origin: location.origin,
          pathname: location.pathname,
          selector,
          value,
          position: { x: lastContextMenuX, y: lastContextMenuY },
        },
      }).catch?.(() => {});
    } catch {
      // ignore if messaging is not available
    }
  },
  true
);

function getStableSelector(element) {
  if (!element || !element.id) {
    const name = element.getAttribute?.('name');
    if (name) {
      const form = element.closest('form');
      const formId = form?.id ? `#${form.id}` : '';
      return `${formId} [name="${name}"]`;
    }
    // Fallback: tag + nth-of-type in parent
    const parent = element.parentElement;
    if (!parent) return element.tagName + (element.name ? `[name="${element.name}"]` : '');
    const siblings = Array.from(parent.children).filter((n) => n.tagName === element.tagName);
    const idx = siblings.indexOf(element);
    if (idx >= 0) {
      const base = parent === document.body ? 'body' : getStableSelector(parent);
      return `${base} > ${element.tagName}:nth-of-type(${idx + 1})`;
    }
    return element.tagName;
  }
  return `#${element.id}`;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'getPageInfo') {
    if (!lastRightClickedElement) {
      sendResponse({ ok: false, error: 'No input focused' });
      return true;
    }
    const selector = getStableSelector(lastRightClickedElement);
    const value = getFieldValue(lastRightClickedElement);
    sendResponse({
      ok: true,
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      selector,
      value,
      position: { x: lastContextMenuX, y: lastContextMenuY },
    });
    return true;
  }

  if (message.type === 'applyValue') {
    const v = message.value ?? '';
    let el = null;
    if (message.selector) {
      try {
        const found = document.querySelector(message.selector);
        if (found && isEditableFormField(found)) el = found;
      } catch (_) {}
    }
    if (!el && document.activeElement && isEditableFormField(document.activeElement)) {
      el = document.activeElement;
    }
    if (!el) el = lastRightClickedElement;
    if (!el) {
      sendResponse({ ok: false, error: 'No input focused' });
      return true;
    }
    setFieldValue(el, v);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'showFloatingMenu') {
    showFloatingMenu(message.entries ?? [], message.position ?? { x: lastContextMenuX, y: lastContextMenuY });
    sendResponse({ ok: true });
    return true;
  }

  // Enable predictive field tracking (called when page has field-specific entries)
  if (message.type === 'enableFieldTracking') {
    enableFieldTracking();
    sendResponse({ ok: true });
    return true;
  }

  // Start pick-element mode (for "This field only" add in sidepanel)
  if (message.type === 'startPickElement') {
    enterPickElementMode();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'cancelPickElement') {
    exitPickElementMode();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'highlightElement') {
    highlightElementOnPage(message.selector, message.useFocused);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'clearHighlight') {
    clearPageHighlight();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ============ PREDICTIVE FIELD TRACKING ============

/**
 * Enable tracking of field interactions to update context menu before right-click.
 * Only enabled when the page has potential field-specific entries.
 */
function enableFieldTracking() {
  if (fieldTrackingEnabled) return;
  fieldTrackingEnabled = true;
  console.log('[Lazy forms] Predictive field tracking enabled');

  // focusin bubbles; mouseover bubbles (mouseenter does NOT!)
  document.addEventListener('focusin', onFieldInteraction, true);
  document.addEventListener('mouseover', onFieldInteraction, true);
  document.addEventListener('mousedown', onFieldInteraction, true);
}

function onFieldInteraction(e) {
  const el = e.target;
  if (!isEditableFormField(el)) return;

  // Debounce: don't send if same selector as last time
  const selector = getStableSelector(el);
  if (selector === lastHoveredSelector) return;
  lastHoveredSelector = selector;

  console.log('[Lazy forms] Predictive: field interacted', e.type, selector);

  // Update lastRightClickedElement so applyValue works even before right-click
  lastRightClickedElement = el;

  // Notify background to update context menu and sidepanel
  try {
    chrome.runtime
      .sendMessage({
        type: 'fieldHovered',
        pageInfo: {
          url: location.href,
          origin: location.origin,
          pathname: location.pathname,
          selector,
        },
      })
      .catch(() => {});

    // Ask background if this field has specific matches; if so, show inline button.
    chrome.runtime.sendMessage(
      {
        type: 'getFieldMatches',
        pageInfo: {
          url: location.href,
          origin: location.origin,
          pathname: location.pathname,
          selector,
        },
      },
      (reply) => {
        if (!reply || !reply.ok) {
          hideFieldButton();
          return;
        }
        const entries = reply.entries || [];
        if (entries.length > 0) {
          ensureFieldButton(el);
        } else if (fieldButtonTarget === el) {
          hideFieldButton();
        }
      }
    );
  } catch (err) {
    if (!String(err?.message || '').includes('Extension context invalidated')) {
      console.warn('[Lazy forms] sendMessage failed', err);
    }
  }
}

// ============ PICK ELEMENT MODE (for "This field only" add) ============

let pickModeOverlay = null;
let pickModeHighlightEl = null;
const PICK_HIGHLIGHT_CLASS = 'lazy-forms-pick-highlight';

function enterPickElementMode() {
  exitPickElementMode();
  const overlay = document.createElement('div');
  overlay.id = 'lazy-forms-pick-overlay';
  overlay.setAttribute('aria-label', 'Click a form field to select it');
  const style = document.createElement('style');
  style.textContent = `
    #lazy-forms-pick-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none !important;
      cursor: crosshair !important;
    }
    body.lazy-forms-pick-mode {
      cursor: crosshair !important;
    }
    .${PICK_HIGHLIGHT_CLASS} {
      outline: 2px solid #4a9eff !important;
      outline-offset: 2px !important;
      background: rgba(74, 158, 255, 0.08) !important;
      cursor: crosshair !important;
      overflow: visible !important;
      overflow-clip-margin: 2px !important;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  document.body.classList.add('lazy-forms-pick-mode');
  pickModeOverlay = overlay;

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (pickModeHighlightEl) {
      pickModeHighlightEl.classList.remove(PICK_HIGHLIGHT_CLASS);
      pickModeHighlightEl = null;
    }
    if (el && isEditableFormField(el)) {
      el.classList.add(PICK_HIGHLIGHT_CLASS);
      pickModeHighlightEl = el;
    }
  }

  function onClick(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !isEditableFormField(el)) return;
    e.preventDefault();
    e.stopPropagation();
    const selector = getStableSelector(el);
    const value = getFieldValue(el);
    try {
      chrome.runtime.sendMessage({ type: 'pickElementResult', selector, value }).catch(() => {});
    } catch {}
    exitPickElementMode();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      exitPickElementMode();
      e.preventDefault();
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey);
  overlay._cleanup = () => {
    document.body.classList.remove('lazy-forms-pick-mode');
    overlay.remove();
    style.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey);
    if (pickModeHighlightEl) {
      pickModeHighlightEl.classList.remove(PICK_HIGHLIGHT_CLASS);
      pickModeHighlightEl = null;
    }
  };
}

function exitPickElementMode() {
  if (pickModeOverlay?._cleanup) {
    pickModeOverlay._cleanup();
    pickModeOverlay = null;
  }
}

// ============ HOVER HIGHLIGHT (list item hover in sidepanel) ============

const HOVER_HIGHLIGHT_CLASS = 'lazy-forms-hover-highlight';
let hoverHighlightEl = null;

function highlightElementOnPage(selector, useFocused) {
  clearPageHighlight();
  let el = null;
  if (useFocused) {
    el = document.activeElement;
    if (!el || !isEditableFormField(el)) return;
  } else if (selector) {
    try {
      el = document.querySelector(selector);
    } catch {}
  }
  if (el) {
    el.classList.add(HOVER_HIGHLIGHT_CLASS);
    hoverHighlightEl = el;
    if (!document.querySelector(`style[data-lazy-forms-hover]`)) {
      const style = document.createElement('style');
      style.setAttribute('data-lazy-forms-hover', '1');
      style.textContent = `.${HOVER_HIGHLIGHT_CLASS} { outline: 2px solid #4a9eff !important; outline-offset: 2px; background: rgba(74, 158, 255, 0.08) !important; }`;
      document.head.appendChild(style);
    }
  }
}

function clearPageHighlight() {
  if (hoverHighlightEl) {
    hoverHighlightEl.classList.remove(HOVER_HIGHLIGHT_CLASS);
    hoverHighlightEl = null;
  }
}

function showFloatingMenu(entries, position) {
  removeExistingFloatingMenu();

  const container = document.createElement('div');
  container.id = 'lazy-forms-floating-menu';
  container.setAttribute('role', 'menu');

  const style = document.createElement('style');
  style.textContent = `
    #lazy-forms-floating-menu {
      position: fixed;
      z-index: 2147483647;
      min-width: 160px;
      max-width: 320px;
      max-height: 320px;
      overflow: auto;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: system-ui, sans-serif;
      font-size: 13px;
      padding: 4px 0;
    }
    #lazy-forms-floating-menu [role="menuitem"] {
      display: block;
      width: 100%;
      padding: 8px 12px;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #lazy-forms-floating-menu [role="menuitem"]:hover {
      background: #f0f0f0;
    }
    #lazy-forms-floating-menu [data-empty] {
      padding: 12px;
      color: #666;
    }
    #lazy-forms-floating-menu hr {
      margin: 6px 0;
      border: none;
      border-top: 1px solid #e0e0e0;
    }
    #lazy-forms-floating-menu .add-value-link {
      display: block;
      padding: 8px 12px;
      color: #4a9eff;
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
    }
    #lazy-forms-floating-menu .add-value-link:hover {
      background: #f0f0f0;
    }
  `;
  document.head.appendChild(style);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.setAttribute('data-empty', '');
    empty.textContent = 'No stored values match this field.';
    container.appendChild(empty);
  } else {
    entries.forEach((entry) => {
      const btn = document.createElement('button');
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      const label = entry.label || entry.value;
      btn.textContent = label.length > 48 ? label.slice(0, 45) + '…' : label;
      btn.title = entry.value;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (lastRightClickedElement) {
          setFieldValue(lastRightClickedElement, entry.value ?? '');
        }
        removeExistingFloatingMenu();
      });
      container.appendChild(btn);
    });
  }

  const hr = document.createElement('hr');
  container.appendChild(hr);
  const addLink = document.createElement('a');
  addLink.className = 'add-value-link';
  addLink.href = '#';
  addLink.textContent = 'Add value…';
  addLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    removeExistingFloatingMenu();
    if (lastRightClickedElement) {
      try {
        chrome.runtime.sendMessage({
          type: 'openSidePanelForAdd',
          pageInfo: {
            url: location.href,
            origin: location.origin,
            pathname: location.pathname,
            selector: getStableSelector(lastRightClickedElement),
            value: getFieldValue(lastRightClickedElement),
          },
        }).catch(() => {});
      } catch {}
    }
  });
  container.appendChild(addLink);

  container.style.left = `${position.x}px`;
  container.style.top = `${position.y}px`;

  document.body.appendChild(container);

  const close = () => {
    removeExistingFloatingMenu();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  container.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('click', close), 0);
}

function removeExistingFloatingMenu() {
  const existing = document.getElementById('lazy-forms-floating-menu');
  if (existing) {
    existing.remove();
    // Reposition the icon after layout settles (e.g. after Jira re-renders on value select)
    if (fieldButtonTarget) {
      let i = 0;
      const interval = setInterval(() => {
        positionFieldButton();
        i++;
        if (i > 8) clearInterval(interval);
      }, 100);
    }
  }
}
