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

/**
 * Run a callback repeatedly at a fixed interval, then stop.
 * @param {() => void} callback
 * @param {number} intervalMs
 * @param {number} times - number of times to run (first run after intervalMs)
 */
function runRepeatedly(callback, intervalMs, times) {
  let count = 0;
  const id = setInterval(() => {
    callback();
    count++;
    if (count >= times) clearInterval(id);
  }, intervalMs);
}

let lastRightClickedElement = null;
let lastContextMenuX = 0;
let lastContextMenuY = 0;

// Predictive tracking state
let fieldTrackingEnabled = false;
let lastHoveredSelector = null;

// Inline field button for showing matches
const FIELD_BUTTON_ID = 'lazy-forms-field-button';
const ICON_SIZE = 18; // px
const ICON_MAX_TOP_OFFSET = 20;
let fieldButtonTarget = null;
let fieldButtonResizeObserver = null;

/** When true, do not reposition the icon (e.g. while user has mouse down on it, so Jira spinner can't steal the click). */
let fieldButtonPositionFrozen = false;

/** Menu position and mouse fallback captured on icon mousedown (before page may hide the input). */
let pendingMenuPosition = null;
let pendingMenuMouseX = 0;
let pendingMenuMouseY = 0;

// Track which field the current floating menu belongs to (if any)
let currentFloatingMenuField = null;

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

function getIconTopOffset(containerRect) {
  return (containerRect.top + Math.min(ICON_MAX_TOP_OFFSET, Math.round((containerRect.height - ICON_SIZE) / 2)));
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
  const top = getIconTopOffset(rect);
  // Use visible right edge so we don't place the icon past overflow:hidden/clip containers (e.g. Jira)
  let visibleRight = getVisibleRightEdge(fieldButtonTarget);
  // Account for field's padding-right (e.g. textareas) so the icon sits at the content edge, not over the padding
  const paddingRightPx = parseFloat(getComputedStyle(fieldButtonTarget).paddingRight) || 0;
  visibleRight -= paddingRightPx;
  const left = visibleRight - ICON_SIZE - 1;
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

const stopEventAndReturnFocus = (e, focusEl) => {
  // IMPORTANT: capture phase, non-passive, stopImmediatePropagation
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  // Keep/restore focus synchronously
  // (preventDefault should already stop focus change, but some pages blur manually, so refocus anyway)
  focusEl?.focus?.({ preventScroll: true });
};

function attachClickNoFocus(el, focusEl, fn) {
  el.addEventListener('click', (e) => {
    stopEventAndReturnFocus(e, focusEl);
    if (typeof fn === 'function') {
      fn(e);
    }
  }, { capture: true, passive: false });

  // Block mousedown/mouseup so the page doesn't blur the field before click
  const killEventAndReturnFocus = (e) => {
    stopEventAndReturnFocus(e, focusEl);
  };
  el.addEventListener('mousedown', killEventAndReturnFocus, true);
  el.addEventListener('mouseup', killEventAndReturnFocus, true);
}

function ensureFieldButton(el) {
  fieldButtonTarget = el;
  let btn = document.getElementById(FIELD_BUTTON_ID);
  if (!btn) {
    btn = document.createElement('button');
    btn.id = FIELD_BUTTON_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Show lazy forms values');
    const menuShortcut = lazyFormsSettings?.shortcutOpenMenu && String(lazyFormsSettings.shortcutOpenMenu).trim();
    btn.title = menuShortcut ? `Lazy values (${menuShortcut})` : 'Lazy values';
    btn.textContent = '≡';
    btn.style.position = 'fixed';
    btn.style.zIndex = '2147483647';
    btn.style.width = `${ICON_SIZE}px`;
    btn.style.height = `${ICON_SIZE}px`;
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

    // Capture menu position and mouse coords here while the input is still in the DOM.
    btn.addEventListener('pointerdown', (e) => {
        stopEventAndReturnFocus(e, fieldButtonTarget);
        fieldButtonPositionFrozen = true;
        pendingMenuMouseX = e.clientX;
        pendingMenuMouseY = e.clientY;
        if (fieldButtonTarget) {
          const rect = fieldButtonTarget.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            const y = getIconTopOffset(rect);
            pendingMenuPosition = { x: rect.right, y };
          } else {
            pendingMenuPosition = null;
          }
        } else {
          pendingMenuPosition = null;
        }
    }, { capture: true, passive: false });

    // Keyboard handling when the icon itself has focus
    btn.addEventListener('keydown', (e) => {
      // Shift+Tab from the icon should return focus to the field (since the icon lives at the end of the tab order)
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (fieldButtonTarget && typeof fieldButtonTarget.focus === 'function') {
          fieldButtonTarget.focus();
        }
      }
    });

    attachClickNoFocus(btn, fieldButtonTarget, () => {
      const target = fieldButtonTarget;
      if (!target) return;
      // Toggle behavior:
      // - If a floating menu is already open for this field, close it.
      // - Otherwise, open (or re-open) the menu for this field.
      const existingMenu = document.getElementById('lazy-forms-floating-menu');
      if (existingMenu && currentFloatingMenuField === target) {
        removeExistingFloatingMenu();
        currentFloatingMenuField = null;
        return;
      }

      lastRightClickedElement = target;
      const selector = getStableSelector(target);
      // Use position captured on mousedown (before page may hide the input). Fallback to mouse position.
      const position =
        pendingMenuPosition && (pendingMenuPosition.x !== 0 || pendingMenuPosition.y !== 0)
          ? { ...pendingMenuPosition }
          : { x: pendingMenuMouseX, y: pendingMenuMouseY };
      pendingMenuPosition = null;
      try {
        chrome.runtime.sendMessage(
          {
            type: 'getFloatingMenuSections',
            pageInfo: {
              url: location.href,
              origin: location.origin,
              pathname: location.pathname,
              selector,
            },
          },
          (reply) => {
            if (!reply || !reply.ok) {
              pendingMenuPosition = null;
              return;
            }
            // Show menu without focusing on mouse click
            showFloatingMenu(reply.sections || {}, position, true);
          }
        ).catch?.(() => { pendingMenuPosition = null; });
      } catch {
        pendingMenuPosition = null;
        // ignore errors (e.g. extension context invalidated)
      }
    });

    document.body.appendChild(btn);
  }
  // Keep tooltip in sync with current shortcut (button may be reused after settings change)
  const menuShortcut = lazyFormsSettings?.shortcutOpenMenu && String(lazyFormsSettings.shortcutOpenMenu).trim();
  btn.title = menuShortcut ? `Lazy values (${menuShortcut})` : 'Lazy values';

  startFieldButtonResizeObserving(el);
  positionFieldButton();
}

function shouldShowFieldIcon(entries, pageHasOtherMatches) {
  const showField = (entries?.length ?? 0) > 0 && lazyFormsSettings.showFieldIcon;
  const showPage = !!pageHasOtherMatches && !!lazyFormsSettings.showIconOnPageValues;
  return showField || showPage;
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

// ============ SETTINGS (icon toggle + shortcut) ============

let lazyFormsSettings = {
  showFieldIcon: true,
  showIconOnPageValues: false,
  shortcutOpenMenu: 'Ctrl+Alt+L',
  shortcutOpenPanel: 'Ctrl+Alt+K',
};

function updateSettingsFromBackground(newSettings) {
  if (!newSettings || typeof newSettings !== 'object') return;
  const merged = {
    ...lazyFormsSettings,
    ...newSettings,
  };
  // Basic validation: ensure shortcut has a non-modifier key at the end; otherwise fall back to default
  if (merged.shortcutOpenMenu && typeof merged.shortcutOpenMenu === 'string') {
    const parts = merged.shortcutOpenMenu.split('+').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last || ['Control', 'Ctrl', 'Shift', 'Alt', 'Meta'].includes(last)) {
      merged.shortcutOpenMenu = 'Ctrl+Alt+L';
    }
  } else {
    merged.shortcutOpenMenu = 'Ctrl+Alt+L';
  }
  // Same validation for panel shortcut
  if (merged.shortcutOpenPanel && typeof merged.shortcutOpenPanel === 'string') {
    const parts = merged.shortcutOpenPanel.split('+').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last || ['Control', 'Ctrl', 'Shift', 'Alt', 'Meta'].includes(last)) {
      merged.shortcutOpenPanel = 'Ctrl+Alt+K';
    }
  } else {
    merged.shortcutOpenPanel = 'Ctrl+Alt+K';
  }
  lazyFormsSettings = merged;
}

/** Get the base (physical) key for shortcut display/matching, so e.g. Digit2 shows "2" not "@". */
function getBaseKeyFromKeyEvent(e) {
  const code = e.code;
  if (code) {
    if (code.startsWith('Digit')) return code.slice(-1);
    if (code.startsWith('Key')) return code.slice(-1).toUpperCase();
    if (code.startsWith('Numpad')) {
      const digit = code.replace('Numpad', '');
      if (/^\d$/.test(digit)) return digit;
    }
  }
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

function normalizeEventToShortcut(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  parts.push(getBaseKeyFromKeyEvent(e));
  return parts.join('+');
}

function matchesConfiguredShortcut(e) {
  if (!lazyFormsSettings || !lazyFormsSettings.shortcutOpenMenu) return false;
  const actual = normalizeEventToShortcut(e);
  return actual.toLowerCase() === String(lazyFormsSettings.shortcutOpenMenu).toLowerCase();
}

function matchesPanelShortcut(e) {
  if (!lazyFormsSettings || !lazyFormsSettings.shortcutOpenPanel) return false;
  const actual = normalizeEventToShortcut(e);
  return actual.toLowerCase() === String(lazyFormsSettings.shortcutOpenPanel).toLowerCase();
}

// Entry shortcuts: key combos assigned to individual stored values
let entryShortcutKeyCombos = new Set();

function refreshEntryShortcuts() {
  try {
    chrome.runtime.sendMessage({ type: 'getEntryShortcuts' }, (response) => {
      if (response?.ok && Array.isArray(response.keyCombos)) {
        entryShortcutKeyCombos = new Set(response.keyCombos);
      }
    });
  } catch {}
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes?.lazyForms) {
    refreshEntryShortcuts();
  }
});

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
      })?.catch(() => {});
    } catch {
      // ignore if messaging is not available
    }
  },
  true
);

// Initial settings load and entry shortcuts
try {
  chrome.runtime.sendMessage({ type: 'getSettings' }, (response) => {
    if (!response?.ok) return;
    updateSettingsFromBackground(response.settings || {});
  });
} catch {}
refreshEntryShortcuts();

// Keyboard shortcuts: side panel, entry shortcuts, or floating menu
document.addEventListener(
  'keydown',
  (e) => {
    if (matchesPanelShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'toggleSidePanel' })?.catch(() => {});
      } catch {}
      return;
    }

    const el = document.activeElement;
    if (!el || !isEditableFormField(el)) return;

    const keyCombo = normalizeEventToShortcut(e).toLowerCase();
    const isEntryShortcut = entryShortcutKeyCombos.has(keyCombo);
    const isMenuShortcut = matchesConfiguredShortcut(e);

    if (!isEntryShortcut && !isMenuShortcut) return;

    e.preventDefault();
    e.stopPropagation();
    lastRightClickedElement = el;
    const selector = getStableSelector(el);
    const pageInfo = {
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      selector,
    };

    if (isEntryShortcut) {
      chrome.runtime.sendMessage(
        { type: 'shortcutPressed', keyCombo, pageInfo },
        (reply) => {
          if (reply?.ok && reply.entry) {
            setFieldValue(el, reply.entry.value ?? '');
          }
        }
      )?.catch?.(() => {});
      return;
    }

    const rect = el.getBoundingClientRect();
    const menuY = getIconTopOffset(rect);
    const position = { x: rect.right, y: menuY };
    try {
      chrome.runtime.sendMessage(
        { type: 'getFloatingMenuSections', pageInfo },
        (reply) => {
          if (!reply || !reply.ok) return;
          showFloatingMenu(reply.sections || {}, position);
        }
      )?.catch(() => {});
    } catch {
      // ignore errors
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

  if (message.type === 'settingsUpdated') {
    updateSettingsFromBackground(message.settings || {});
    const existingBtn = document.getElementById(FIELD_BUTTON_ID);
    if (existingBtn) {
      const menuShortcut = lazyFormsSettings?.shortcutOpenMenu && String(lazyFormsSettings.shortcutOpenMenu).trim();
      existingBtn.title = menuShortcut ? `Lazy values (${menuShortcut})` : 'Lazy values';
    }
    if (!lazyFormsSettings.showFieldIcon && !lazyFormsSettings.showIconOnPageValues) {
      hideFieldButton();
    } else {
      // If any icon setting is on, try to show icon for the current focused field (if any)
      const el = document.activeElement;
      if (el && isEditableFormField(el)) {
        lastRightClickedElement = el;
        const selector = getStableSelector(el);
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
              if (!reply || !reply.ok) {
                hideFieldButton();
                return;
              }
              const entries = reply.entries || [];
              const pageHasOtherMatches = !!reply.pageHasOtherMatches;
              if (shouldShowFieldIcon(entries, pageHasOtherMatches)) {
                ensureFieldButton(el);
              } else if (fieldButtonTarget === el) {
                hideFieldButton();
              }
            }
          )?.catch(() => {});
        } catch {
          // ignore
        }
      } else if (fieldButtonTarget) {
        // No focused field but icon might be visible from a previous field; re-check with that field
        const el = fieldButtonTarget;
        const selector = getStableSelector(el);
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
              const pageHasOtherMatches = !!reply.pageHasOtherMatches;
              if (!shouldShowFieldIcon(entries, pageHasOtherMatches)) {
                hideFieldButton();
              }
            }
          )?.catch(() => {});
        } catch {}
      }
    }
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
  // console.log('[Lazy forms] Predictive field tracking enabled');

  // focusin bubbles; mouseover bubbles (mouseenter does NOT!)
  document.addEventListener('focusin', onFieldInteraction, true);
  document.addEventListener('mouseover', onFieldInteraction, true);
  document.addEventListener('mousedown', onFieldInteraction, true);

  // Pages may autofocus an input before our listeners run, or shortly after (e.g. google.com).
  // Check activeElement now and again after short delays to catch delayed autofocus.
  function checkAutofocusedField() {
    try {
      const el = document.activeElement;
      if (el && isEditableFormField(el)) {
        onFieldInteraction({ type: 'autofocus', target: el });
      }
    } catch (_) {}
  }
  checkAutofocusedField();
  runRepeatedly(checkAutofocusedField, 100, 5);
}

function onFieldInteraction(e) {
  const el = e.target;
  if (!isEditableFormField(el)) return;

  // Debounce: don't send if same selector as last time
  const selector = getStableSelector(el);
  if (selector === lastHoveredSelector) return;
  lastHoveredSelector = selector;

  // console.log('[Lazy forms] Predictive: field interacted', e.type, selector);

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

    // Ask background if this field has specific matches; if so, show inline button (if enabled in settings).
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
        const pageHasOtherMatches = !!reply.pageHasOtherMatches;
        if (shouldShowFieldIcon(entries, pageHasOtherMatches)) {
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
      chrome.runtime.sendMessage({ type: 'pickElementResult', selector, value })?.catch(() => {});
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

/**
 * @param {{ field?: unknown[], url?: unknown[], domain?: unknown[], custom?: unknown[], all?: unknown[] } | unknown[]} sectionsOrEntries
 * @param {{ x: number, y: number }} position
 */
function showFloatingMenu(sectionsOrEntries, position, noFocus = false) {
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
      color: #000;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #lazy-forms-floating-menu [role="menuitem"] .lazy-forms-floater-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #lazy-forms-floating-menu [role="menuitem"] .lazy-forms-floater-shortcut {
      flex-shrink: 0;
      font-size: 11px;
      color: #888;
    }
    #lazy-forms-floating-menu [role="menuitem"]:hover {
      background: #f0f0f0;
    }
    #lazy-forms-floating-menu [role="menuitem"]:focus,
    #lazy-forms-floating-menu .add-value-link:focus {
      outline: 2px solid #000;
      outline-offset: -2px;
      background: #f0f0f0;
      border-radius: 4px;
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
      color: #000;
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
    }
    #lazy-forms-floating-menu .add-value-link:hover {
      background: #f0f0f0;
    }
    #lazy-forms-floating-menu .add-value-link .lazy-forms-floater-shortcut {
      flex-shrink: 0;
      font-size: 11px;
      color: #888;
    }
  `;
  document.head.appendChild(style);

  const items = [];
  const isSections =
    sectionsOrEntries &&
    typeof sectionsOrEntries === 'object' &&
    !Array.isArray(sectionsOrEntries) &&
    'field' in sectionsOrEntries;

  function appendEntryButton(entry) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.type = 'button';
    const hasLabel = entry.label != null && String(entry.label).trim() !== '';
    const displayText = hasLabel
      ? entry.label
      : (entry.value != null && String(entry.value) !== '' ? `"${entry.value}"` : '"(empty value)"');
    const hasShortcut = entry.shortcut && String(entry.shortcut).trim();
    if (hasShortcut) {
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.gap = '6px';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'lazy-forms-floater-label';
      const truncated = displayText.length > 36 ? displayText.slice(0, 33) + '…' : displayText;
      labelSpan.textContent = truncated;
      const shortcutSpan = document.createElement('span');
      shortcutSpan.className = 'lazy-forms-floater-shortcut';
      shortcutSpan.textContent = `(${entry.shortcut})`;
      btn.appendChild(labelSpan);
      btn.appendChild(shortcutSpan);
    } else {
      btn.textContent = displayText.length > 48 ? displayText.slice(0, 45) + '…' : displayText;
    }
    btn.title = entry.value;

    attachClickNoFocus(btn, lastRightClickedElement, () => {
      if (lastRightClickedElement) {
        setFieldValue(lastRightClickedElement, entry.value ?? '');
      }
      close();
    });
    container.appendChild(btn);
    items.push(btn);
  }

  if (isSections) {
    const sections = sectionsOrEntries;
    const sectionOrder = ['field', 'url', 'domain', 'custom', 'all'];
    let needDivider = false;
    for (const key of sectionOrder) {
      const entries = Array.isArray(sections[key]) ? sections[key] : [];
      if (entries.length === 0) continue;
      if (needDivider) container.appendChild(document.createElement('hr'));
      needDivider = true;
      entries.forEach(appendEntryButton);
    }
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.setAttribute('data-empty', '');
      empty.textContent = 'No stored values match this field.';
      container.appendChild(empty);
    }
  } else {
    const entries = Array.isArray(sectionsOrEntries) ? sectionsOrEntries : [];
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.setAttribute('data-empty', '');
      empty.textContent = 'No stored values match this field.';
      container.appendChild(empty);
    } else {
      entries.forEach(appendEntryButton);
    }
  }

  container.appendChild(document.createElement('hr'));
  const addLink = document.createElement('a');
  addLink.className = 'add-value-link';
  addLink.href = '#';
  addLink.textContent = 'Add value…';
  attachClickNoFocus(addLink, lastRightClickedElement, () => {
    close();
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
        })?.catch(() => {});
      } catch {}
    }
  });
  container.appendChild(addLink);
  items.push(addLink);

  const panelLink = document.createElement('a');
  panelLink.className = 'add-value-link';
  panelLink.href = '#';
  panelLink.style.display = 'flex';
  panelLink.style.alignItems = 'center';
  panelLink.style.gap = '6px';
  const panelShortcut = lazyFormsSettings?.shortcutOpenPanel && String(lazyFormsSettings.shortcutOpenPanel).trim();
  if (panelShortcut) {
    panelLink.appendChild(document.createTextNode('Side panel…'));
    const panelShortcutSpan = document.createElement('span');
    panelShortcutSpan.className = 'lazy-forms-floater-shortcut';
    panelShortcutSpan.textContent = `(${panelShortcut})`;
    panelLink.appendChild(panelShortcutSpan);
  } else {
    panelLink.textContent = 'Side panel…';
  }

  attachClickNoFocus(panelLink, lastRightClickedElement, () => {
    close();
    try {
      chrome.runtime.sendMessage({ type: 'openSidePanelForAdd' })?.catch(() => {});
    } catch {}
  });
  container.appendChild(panelLink);
  items.push(panelLink);

  container.style.left = `${position.x}px`;
  container.style.top = `${position.y}px`;

  document.body.appendChild(container);

  // Clamp to viewport so the menu is not cut off when the field is near the edge
  const menuRect = container.getBoundingClientRect();
  const padding = 8;
  let left = position.x;
  let top = position.y;
  if (left + menuRect.width > window.innerWidth - padding) {
    left = window.innerWidth - menuRect.width - padding;
  }
  if (left < padding) left = padding;
  if (top + menuRect.height > window.innerHeight - padding) {
    top = window.innerHeight - menuRect.height - padding;
  }
  if (top < padding) top = padding;
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;

  // Remember which field this menu belongs to (for icon-toggle behavior)
  currentFloatingMenuField = lastRightClickedElement || null;

  // Focus first item (if not noFocus) when opened so it is keyboard navigable (especially when opened via shortcut)
  if (!noFocus && items.length > 0) {
    try {
      items[0].focus();
    } catch {}
  }

  const close = () => {
    removeExistingFloatingMenu();
    // Restore focus to the original field so the user can continue typing
    try {
      if (lastRightClickedElement && typeof lastRightClickedElement.focus === 'function') {
        lastRightClickedElement.focus();
      }
    } catch {}
    currentFloatingMenuField = null;
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (!items.length) return;

    const currentIndex = items.findIndex((el) => el === document.activeElement);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let nextIndex = 0;
      if (currentIndex === -1) {
        nextIndex = 0;
      } else if (e.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % items.length;
      } else {
        nextIndex = (currentIndex - 1 + items.length) % items.length;
      }
      try {
        items[nextIndex].focus();
      } catch {}
      return;
    }

    if (e.key === 'Enter') {
      if (currentIndex >= 0 && currentIndex < items.length) {
        e.preventDefault();
        items[currentIndex].click();
      }
      return;
    }
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
      runRepeatedly(positionFieldButton, 100, 8);
    }
  }
}
