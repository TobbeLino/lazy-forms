/**
 * Background service worker: single source of truth for entries and page state.
 *
 * Architecture:
 * - getMatchingEntries(entries, pageInfo) - pure function, returns matching entries
 * - activeTabState[tabId] = { pageInfo } - tracked state per tab
 * - refreshAll(tabId) - loads entries, computes matches, updates context menu, broadcasts to sidepanel
 *
 * Triggers for refreshAll:
 * 1. tabs.onUpdated (status=complete) - page load
 * 2. storage.onChanged - entries added/removed/updated
 * 3. contextMenuOpened message - right-click with selector
 * 4. getState message - sidepanel requests current state
 */

const STORAGE_KEY = 'lazyForms';
const VERSION = 1;
const PENDING_STORE_KEY = 'lazy-forms-pendingStore';

// Global extension settings with safe defaults.
const DEFAULT_SETTINGS = {
  // Whether to show the inline icon on matching fields.
  showFieldIcon: true,
  // Whether to show the icon when the page has any matches without path/selector (URL, domain, custom URL, all).
  showIconOnPageValues: false,
  // Keyboard shortcut used to open the floating menu on the focused field.
  // Stored as a human-readable string; content scripts normalize for matching.
  shortcutOpenMenu: 'Ctrl+Alt+L',
  // Keyboard shortcut used to open the side panel.
  shortcutOpenPanel: 'Ctrl+Alt+K',
};

// ============ STATE ============

// Page info per tab: { url, origin, pathname, selector }
const activeTabState = {};

// Quick slot entry IDs (for root menu items)
const MAX_QUICK_SLOTS = 10;
const quickSlots = Array(MAX_QUICK_SLOTS).fill(null);

// Entries cache for fast field-hover updates (avoids storage read on every interaction)
let entriesCache = [];
let cacheValid = false;

// Tab that is currently in pick-element (aim) mode; null if none
let pickModeTabId = null;

// Tab ID for which we believe the side panel is open (for toolbar icon toggle)
let sidePanelOpenTabId = null;

// ============ HELPERS ============

/** Send message without throwing when extension context is invalidated (e.g. after reload). */
function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg)?.catch(() => {});
  } catch (e) {
    const msg = String(e?.message ?? e ?? '');
    if (!msg.includes('Extension context invalidated')) throw e;
  }
}

/** Update the extension toolbar icon tooltip to show the side panel shortcut. */
function updateActionTitle(settings) {
  const action = typeof chrome !== 'undefined' ? chrome.action : typeof browser !== 'undefined' ? browser.action : null;
  if (!settings || !action?.setTitle) return;
  const shortcut = settings.shortcutOpenPanel && String(settings.shortcutOpenPanel).trim();
  const title = shortcut ? `Lazy forms (${shortcut})` : 'Lazy forms';
  try {
    action.setTitle({ title });
  } catch {}
}

/** Open the side panel (Chrome: sidePanel; Firefox: sidebar). */
function openSidePanel(tabId, windowId) {
  if (typeof chrome !== 'undefined' && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId, windowId });
  } else if (typeof browser !== 'undefined' && browser.sidebarAction?.open) {
    browser.sidebarAction.open();
  }
}

// ============ STORAGE ============

async function loadStorage() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const settings =
    data && typeof data.settings === 'object'
      ? { ...DEFAULT_SETTINGS, ...data.settings }
      : { ...DEFAULT_SETTINGS };

  entriesCache = rawEntries;
  cacheValid = true;

  return {
    version: data?.version ?? VERSION,
    entries: rawEntries,
    settings,
  };
}

function getEntriesCached() {
  if (cacheValid) return entriesCache;
  // Cache not valid, return empty (caller should use loadStorage for critical paths)
  return [];
}

async function saveSettings(partialSettings) {
  if (!partialSettings || typeof partialSettings !== 'object') return;
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const existing = result[STORAGE_KEY] || { version: VERSION, entries: [], settings: DEFAULT_SETTINGS };
  const mergedSettings = {
    ...DEFAULT_SETTINGS,
    ...(existing.settings || {}),
    ...partialSettings,
  };
  const next = { ...existing, settings: mergedSettings };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return mergedSettings;
}

// ============ MATCHING (pure function) ============

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function originMatches(keyOrigin, origin) {
  if (!keyOrigin || !origin) return keyOrigin === origin;
  if (keyOrigin.includes('*') || keyOrigin.includes('?')) {
    try {
      return globToRegex(keyOrigin).test(origin);
    } catch {
      return false;
    }
  }
  return keyOrigin === origin;
}

function matchesContext(entry, pageInfo) {
  if (!pageInfo) return false;
  const { url, origin, pathname, selector } = pageInfo;
  switch (entry.contextType) {
    case 'fieldOnly': {
      if (!selector) return false;
      const key = (entry.contextKey || '').trim();
      if (!key) return false;

      // Support wildcards for full keys: origin|pathname|selector
      if (key.includes('|')) {
        const parts = key.split('|');
        if (parts.length === 3) {
          const [keyOrigin, keyPathname, keySelector] = parts;

          if (originMatches(keyOrigin, origin)) {
            // Pathname: support '*' / '?' wildcards; empty or '*' means "any path"
            let pathnameMatches = false;
            if (!keyPathname || keyPathname === '*') {
              pathnameMatches = true;
            } else if (keyPathname.includes('*') || keyPathname.includes('?')) {
              try {
                pathnameMatches = globToRegex(keyPathname).test(pathname);
              } catch {
                pathnameMatches = false;
              }
            } else {
              pathnameMatches = keyPathname === pathname;
            }

            if (pathnameMatches) {
              // Selector: support '*' / '?' wildcards; empty or '*' means "any selector"
              let selectorMatches = false;
              if (!keySelector || keySelector === '*') {
                selectorMatches = true;
              } else if (keySelector.includes('*') || keySelector.includes('?')) {
                try {
                  selectorMatches = globToRegex(keySelector).test(selector);
                } catch {
                  selectorMatches = false;
                }
              } else {
                selectorMatches = keySelector === selector;
              }

              if (selectorMatches) return true;
            }
          }
        } else {
          // Fallback for unexpected key shapes: keep old exact-match behavior
          if (key === `${origin}|${pathname}|${selector}`) return true;
        }
        return false;
      }

      // Selector-only (e.g. #searchOverlayInput) → match this field on any site
      // Now with optional '*' / '?' wildcards.
      if (!key.includes('://')) {
        if (key.includes('*') || key.includes('?')) {
          try {
            return globToRegex(key).test(selector);
          } catch {
            return false;
          }
        }
        return selector === key;
      }
      return false;
    }
    case 'url':
      return entry.contextKey === url;
    case 'domain':
      return entry.contextKey === origin;
    case 'all':
      return true;
    case 'urlPattern': {
      const key = entry.contextKey || '';
      const parts = key.split('|');

      // 1) origin|pathname|selector → origin and pathname can be exact or glob; selector can be exact or glob
      // Examples:
      //   https://puzzel.atlassian.net|*|#react-select-3-input
      //   https://puzzel.atlassian.net|/some/path|#react-select-*-input
      if (parts.length === 3 && selector) {
        const [keyOrigin, keyPathname, keySelector] = parts;

        if (originMatches(keyOrigin, origin)) {
          // Pathname: support '*' / '?' wildcards; empty or '*' means "any path"
          let pathnameMatches = false;
          if (!keyPathname || keyPathname === '*') {
            pathnameMatches = true;
          } else if (keyPathname.includes('*') || keyPathname.includes('?')) {
            try {
              pathnameMatches = globToRegex(keyPathname).test(pathname);
            } catch {
              pathnameMatches = false;
            }
          } else {
            pathnameMatches = keyPathname === pathname;
          }

          if (pathnameMatches) {
            // Selector: support '*' / '?' wildcards
            let selectorMatches = false;
            if (!keySelector || keySelector === '*') {
              selectorMatches = true;
            } else if (keySelector.includes('*') || keySelector.includes('?')) {
              try {
                selectorMatches = globToRegex(keySelector).test(selector);
              } catch {
                selectorMatches = false;
              }
            } else {
              selectorMatches = keySelector === selector;
            }

            if (selectorMatches) return true;
          }
        }
      }

      // 2) selector only (e.g. #searchOverlayInput) → match any site when this field is focused
      if (!key.includes('|') && !key.includes('://') && selector && key.trim() !== '') {
        if (selector === key.trim()) return true;
      }

      // 3) Otherwise match as URL glob pattern
      try {
        return globToRegex(key).test(url);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function getMatchingEntries(entries, pageInfo) {
  if (!pageInfo || !Array.isArray(entries)) return [];
  return entries.filter((e) => matchesContext(e, pageInfo));
}

/** True if entry belongs in the floating menu "field" section (field-only or custom with path/selector). */
function isFieldSectionEntry(entry) {
  if (entry.contextType === 'fieldOnly') return true;
  if (entry.contextType === 'urlPattern') {
    const key = (entry.contextKey || '').trim();
    if (!key) return false;
    // Wildcard "*" (or URL-only pattern) has no path/selector → not field section
    if (key === '*' || key.includes('://')) return false;
    if (!key.includes('|')) return true; // selector-only (e.g. #id)
    const parts = key.split('|');
    return parts.length === 3; // origin|pathname|selector
  }
  return false;
}

const FLOATING_MENU_SECTION_MAX = 5;

/**
 * Build sections for the floating menu: field (all matching), url, domain, custom, all (max 5 each for latter).
 * Custom = urlPattern that matched by URL glob only (no path/selector); no duplicates from field section.
 */
function getFloatingMenuSections(entries, pageInfo) {
  if (!pageInfo || !Array.isArray(entries)) {
    return { field: [], url: [], domain: [], custom: [], all: [] };
  }
  const matches = getMatchingEntries(entries, pageInfo);
  const field = sortBySpecificity(matches.filter(isFieldSectionEntry));
  const fieldIds = new Set(field.map((e) => e.id));
  const url = sortBySpecificity(matches.filter((e) => e.contextType === 'url')).slice(0, FLOATING_MENU_SECTION_MAX);
  const domain = sortBySpecificity(matches.filter((e) => e.contextType === 'domain')).slice(0, FLOATING_MENU_SECTION_MAX);
  const custom = sortBySpecificity(
    matches.filter((e) => e.contextType === 'urlPattern' && !fieldIds.has(e.id))
  ).slice(0, FLOATING_MENU_SECTION_MAX);
  const all = sortBySpecificity(matches.filter((e) => e.contextType === 'all')).slice(0, FLOATING_MENU_SECTION_MAX);
  return { field, url, domain, custom, all };
}

const SPECIFICITY_RANK = { fieldOnly: 0, url: 1, domain: 2, all: 3, urlPattern: 4 };

function sortOrder(a) {
  return a.order ?? a.createdAt ?? 0;
}

function sortBySpecificity(entries) {
  return [...entries].sort((a, b) => {
    const specA = SPECIFICITY_RANK[a.contextType] ?? 99;
    const specB = SPECIFICITY_RANK[b.contextType] ?? 99;
    if (specA !== specB) return specA - specB;
    return sortOrder(a) - sortOrder(b);
  });
}

// ============ CONTEXT MENU ============

/**
 * Update quick slots in root menu with all matching entries.
 * With predictive field tracking, field-specific entries are updated before right-click.
 */
function updateQuickSlots(matches) {
  const sorted = sortBySpecificity(matches);
  const top = sorted.slice(0, MAX_QUICK_SLOTS);

  for (let i = 0; i < MAX_QUICK_SLOTS; i++) {
    const entry = top[i];
    const menuId = `lazy-forms-quick-${i}`;
    quickSlots[i] = entry?.id || null;

    if (!entry) {
      chrome.contextMenus.update(menuId, { visible: false })?.catch(() => {});
    } else {
      const hasLabel = entry.label != null && String(entry.label).trim() !== '';
      const raw = hasLabel
        ? String(entry.label).trim()
        : (entry.value != null && String(entry.value) !== '' ? `"${entry.value}"` : '"(empty value)"');
      const base = raw.length > 32 ? `${raw.slice(0, 29)}…` : raw;
      const withShortcut =
        entry.shortcut && String(entry.shortcut).trim()
          ? `${base} (${String(entry.shortcut).trim()})`
          : base;
      chrome.contextMenus.update(menuId, { visible: true, title: withShortcut })?.catch(() => {});
    }
  }
}

// ============ CORE REFRESH FUNCTION ============

/**
 * Check if there are any field-only (or field-specific urlPattern) entries that could match this page.
 * Used to decide whether to enable predictive field tracking and thus the inline field icon.
 */
function hasFieldEntriesForPage(entries, pageInfo) {
  if (!pageInfo) return false;
  const { origin, pathname } = pageInfo;

  function pathnameCouldMatch(keyPathname) {
    if (!keyPathname || keyPathname === '*') return true;
    if (keyPathname.includes('*') || keyPathname.includes('?')) {
      try {
        return globToRegex(keyPathname).test(pathname);
      } catch {
        return false;
      }
    }
    return keyPathname === pathname;
  }

  return entries.some((e) => {
    const key = (e.contextKey || '').trim();
    if (!key) return false;

    // 1) fieldOnly entries
    if (e.contextType === 'fieldOnly') {
      // Selector-only (e.g. #id): can match on any site → enable tracking
      if (!key.includes('://') && !key.includes('|')) return true;

      // origin|pathname|selector: enable if origin + pathname could match (with wildcards)
      if (key.includes('|')) {
        const parts = key.split('|');
        if (parts.length >= 2) {
          const [keyOrigin, keyPathname] = parts;
          if (!originMatches(keyOrigin, origin)) return false;
          return pathnameCouldMatch(keyPathname);
        }
        // legacy: exact prefix match
        const prefix = `${origin}|${pathname}|`;
        return key.startsWith(prefix);
      }
      return false;
    }

    // 2) urlPattern entries that could match a field on this page
    if (e.contextType === 'urlPattern') {
      if (!key.includes('|') && !key.includes('://')) return true;

      const parts = key.split('|');
      if (parts.length >= 2) {
        const [keyOrigin, keyPathname] = parts;
        if (!originMatches(keyOrigin, origin)) return false;
        return pathnameCouldMatch(keyPathname);
      }
    }

    return false;
  });
}

/**
 * The ONE function that refreshes everything for a tab.
 * Called on: page load, storage change, context menu open, sidepanel request, field hover.
 */
async function refreshAll(tabId) {
  if (!tabId) return null;

  const pageInfo = activeTabState[tabId]?.pageInfo;
  const { entries } = await loadStorage();
  const matches = getMatchingEntries(entries, pageInfo);

  // Update quick slots in root menu
  updateQuickSlots(matches);

  // Broadcast to sidepanel (if open)
  const state = { pageInfo, entries, matches };
  safeSendMessage({ type: 'stateUpdated', state });

  // Enable predictive field tracking when there are field-only entries that could match, or any
  // page-level matches (URL, domain, custom, all) so the icon can show for "matching page values".
  if (pageInfo && entries.length > 0) {
    const hasFieldEntries = hasFieldEntriesForPage(entries, pageInfo);
    const hasPageMatches = matches.some((e) => !isFieldSectionEntry(e));
    if (hasFieldEntries || hasPageMatches) {
      chrome.tabs.sendMessage(tabId, { type: 'enableFieldTracking' })?.catch(() => {});
    }
  }

  return state;
}

// ============ PAGE INFO HELPERS ============

function pageInfoFromUrl(url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    const u = new URL(url);
    return { url, origin: u.origin, pathname: u.pathname, selector: '' };
  } catch {
    return null;
  }
}

function updatePageInfo(tabId, pageInfo) {
  if (!tabId) return;
  activeTabState[tabId] = { pageInfo };
}

// ============ EVENT HANDLERS ============

// 1. Tab updated (page load complete)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    // If this tab was in aim/pick mode, exit it (page reloaded)
    if (pickModeTabId === tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'cancelPickElement' })?.catch(() => {});
      pickModeTabId = null;
      chrome.runtime.sendMessage({ type: 'resetAimMode' })?.catch(() => {});
    }
    const pageInfo = pageInfoFromUrl(tab.url);
    // Preserve existing selector only if same page (origin+pathname) so we don't clear field-specific state on noise
    const existing = activeTabState[tabId]?.pageInfo;
    if (existing?.selector && pageInfo && existing.origin === pageInfo.origin && existing.pathname === pageInfo.pathname) {
      pageInfo.selector = existing.selector;
    }
    updatePageInfo(tabId, pageInfo);
    refreshAll(tabId);
  }
});

// 2. Tab activated (user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // If we were in aim mode on another tab, exit it
  if (pickModeTabId != null && activeInfo.tabId !== pickModeTabId) {
    chrome.tabs.sendMessage(pickModeTabId, { type: 'cancelPickElement' })?.catch(() => {});
    pickModeTabId = null;
    chrome.runtime.sendMessage({ type: 'resetAimMode' })?.catch(() => {});
  }
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (tab?.url) {
    // Use existing state if we have it (preserves selector), otherwise create from URL
    if (!activeTabState[activeInfo.tabId]) {
      const pageInfo = pageInfoFromUrl(tab.url);
      updatePageInfo(activeInfo.tabId, pageInfo);
    }
    refreshAll(activeInfo.tabId);
  }
});

// 3. Storage changed (entries added/removed/updated)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[STORAGE_KEY]) {
    // Invalidate cache
    cacheValid = false;
    const newData = changes[STORAGE_KEY].newValue;
    entriesCache = newData?.entries || [];
    cacheValid = true;

    // Refresh the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) refreshAll(tabs[0].id);
    });
  }
});

// 4. Messages from content script and sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script: context menu opened with full pageInfo including selector
  if (message.type === 'contextMenuOpened' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (message.pageInfo) {
      const pageInfo = {
        url: message.pageInfo.url,
        origin: message.pageInfo.origin,
        pathname: message.pageInfo.pathname,
        selector: message.pageInfo.selector || '',
      };
      updatePageInfo(tabId, pageInfo);
      refreshAll(tabId);
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // Content script: request field-specific matches for current element (used by inline field button)
  if (message.type === 'getFieldMatches' && sender.tab?.id) {
    (async () => {
      const tabId = sender.tab.id;
      let pageInfo = null;
      if (message.pageInfo) {
        pageInfo = {
          url: message.pageInfo.url,
          origin: message.pageInfo.origin,
          pathname: message.pageInfo.pathname,
          selector: message.pageInfo.selector || '',
        };
      } else {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.url) pageInfo = pageInfoFromUrl(tab.url);
      }

      if (!pageInfo) {
        sendResponse?.({ ok: false, error: 'No pageInfo' });
        return;
      }

      const { entries } = await loadStorage();
      const allMatches = getMatchingEntries(entries, pageInfo);

      // Only keep field-specific matches: explicit fieldOnly, or urlPattern rules
      // that are selector-based (selector-only or origin|pathname|selector).
      const fieldMatches = allMatches.filter(isFieldSectionEntry);
      const pageHasOtherMatches = allMatches.some((e) => !isFieldSectionEntry(e));

      sendResponse?.({
        ok: true,
        entries: sortBySpecificity(fieldMatches),
        pageHasOtherMatches,
      });
    })();
    return true; // async
  }

  // Content script: request sections for floating menu (field, url, domain, custom, all)
  if (message.type === 'getFloatingMenuSections' && sender.tab?.id) {
    (async () => {
      const tabId = sender.tab.id;
      let pageInfo = null;
      if (message.pageInfo) {
        pageInfo = {
          url: message.pageInfo.url,
          origin: message.pageInfo.origin,
          pathname: message.pageInfo.pathname,
          selector: message.pageInfo.selector || '',
        };
      } else {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.url) pageInfo = pageInfoFromUrl(tab.url);
      }
      if (!pageInfo) {
        sendResponse?.({ ok: false, error: 'No pageInfo' });
        return;
      }
      const { entries } = await loadStorage();
      const sections = getFloatingMenuSections(entries, pageInfo);
      sendResponse?.({ ok: true, sections });
    })();
    return true; // async
  }

  // Content script: user hovered/focused on a field - predictive update
  // Use cached entries for speed (this happens frequently)
  if (message.type === 'fieldHovered' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (message.pageInfo) {
      const pageInfo = {
        url: message.pageInfo.url,
        origin: message.pageInfo.origin,
        pathname: message.pageInfo.pathname,
        selector: message.pageInfo.selector || '',
      };
      updatePageInfo(tabId, pageInfo);

      const entries = getEntriesCached();
      if (entries.length > 0) {
        const matches = getMatchingEntries(entries, pageInfo);
        updateQuickSlots(matches);
        // Broadcast to sidepanel so it updates too
        safeSendMessage({ type: 'stateUpdated', state: { pageInfo, entries, matches } });
      }
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // Content script: toggle side panel via keyboard shortcut (no pre-fill)
  if (message.type === 'toggleSidePanel' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (sidePanelOpenTabId === tabId) {
      chrome.runtime.sendMessage({ type: 'requestClosePanel' }, (response) => {
        if (response?.closing) sidePanelOpenTabId = null;
      });
    } else {
      try {
        openSidePanel(tabId, sender.tab.windowId);
        sidePanelOpenTabId = tabId;
      } catch {}
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // Content script: open side panel for "Add value…" from floating menu (pre-fill with current field)
  if (message.type === 'openSidePanelForAdd' && sender.tab?.id) {
    const tabId = sender.tab.id;
    try {
      openSidePanel(tabId, sender.tab.windowId);
      sidePanelOpenTabId = tabId;
    } catch {}
    (async () => {
      const pageInfo = message.pageInfo
        ? {
            url: message.pageInfo.url,
            origin: message.pageInfo.origin,
            pathname: message.pageInfo.pathname,
            selector: message.pageInfo.selector || '',
            value: message.pageInfo.value,
          }
        : null;
      if (pageInfo) {
        await chrome.storage.session.set({ [PENDING_STORE_KEY]: pageInfo });
        updatePageInfo(tabId, pageInfo);
      }
      setTimeout(() => refreshAll(tabId), 100);
    })();
    sendResponse?.({ ok: true });
    return true;
  }

  // Sidepanel: close panel (user clicked X; clear toggle state so toolbar icon can re-open)
  if (message.type === 'closeSidePanel') {
    sidePanelOpenTabId = null;
    sendResponse?.({ ok: true });
    return true;
  }

  // Sidepanel: panel is closing (so toolbar icon toggle state stays in sync)
  if (message.type === 'panelClosing') {
    sidePanelOpenTabId = null;
    sendResponse?.({ ok: true });
    return true;
  }

  // Content script: get key combos used by entry shortcuts (for synchronous "should we handle this key?")
  if (message.type === 'getEntryShortcuts') {
    (async () => {
      const { entries } = await loadStorage();
      const keyCombos = (entries || [])
        .filter((e) => e.shortcut && String(e.shortcut).trim())
        .map((e) => String(e.shortcut).trim().toLowerCase());
      sendResponse?.({ ok: true, keyCombos: [...new Set(keyCombos)] });
    })();
    return true;
  }

  // Content script: key combo pressed on page; return entry for that shortcut (always paste into active field, regardless of context match)
  if (message.type === 'shortcutPressed' && sender.tab?.id) {
    (async () => {
      const keyCombo = message.keyCombo && String(message.keyCombo).trim().toLowerCase();
      if (!keyCombo) {
        sendResponse?.({ ok: false });
        return;
      }
      const { entries } = await loadStorage();
      const withShortcut = (entries || []).filter(
        (e) => e.shortcut && String(e.shortcut).trim().toLowerCase() === keyCombo
      );
      const sorted = sortBySpecificity(withShortcut);
      const entry = sorted[0] || null;
      sendResponse?.({ ok: true, entry });
    })();
    return true;
  }

  // Any script: request current settings (with defaults applied)
  if (message.type === 'getSettings') {
    (async () => {
      const { settings } = await loadStorage();
      updateActionTitle(settings);
      sendResponse?.({ ok: true, settings });
    })();
    return true;
  }

  // Sidepanel: update settings (e.g. showFieldIcon, shortcutOpenMenu)
  if (message.type === 'updateSettings') {
    (async () => {
      const merged = await saveSettings(message.settings || {});

      updateActionTitle(merged);

      // Notify sidepanel and any other extension pages
      safeSendMessage({ type: 'settingsUpdated', settings: merged });

      // Broadcast to all tabs so content scripts update without reload
      chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
        tabs.forEach((tab) => {
          if (!tab.id) return;
          chrome.tabs.sendMessage(tab.id, { type: 'settingsUpdated', settings: merged })?.catch(() => {});
        });
      });

      sendResponse?.({ ok: true, settings: merged });
    })();
    return true;
  }

  // Sidepanel: request current state
  if (message.type === 'getState') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        if (!activeTabState[tab.id]) {
          const pageInfo = pageInfoFromUrl(tab.url);
          updatePageInfo(tab.id, pageInfo);
        }
        const state = await refreshAll(tab.id);
        sendResponse?.({ ok: true, state });
      } else {
        // No active tab (e.g. side panel focused): still send entries so list can show with "Show all values"
        const { entries } = await loadStorage();
        sendResponse?.({ ok: true, state: { pageInfo: null, entries: entries || [], matches: [] } });
      }
    })();
    return true; // async response
  }

  // Sidepanel: refresh after store action
  if (message.type === 'refreshSidePanelForStore') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) refreshAll(tabs[0].id);
    });
    sendResponse?.({ ok: true });
    return true;
  }

  // Sidepanel: start pick-element mode on active tab (for "This field only" add)
  if (message.type === 'startPickElement') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        pickModeTabId = tabs[0].id;
        chrome.tabs.sendMessage(tabs[0].id, { type: 'startPickElement' })?.catch(() => {});
      }
      sendResponse?.({ ok: true });
    });
    return true;
  }

  // Sidepanel: cancel pick-element mode (e.g. add form closed)
  if (message.type === 'cancelPickElement') {
    const tabIdToCancel = pickModeTabId;
    pickModeTabId = null;
    if (tabIdToCancel) {
      chrome.tabs.sendMessage(tabIdToCancel, { type: 'cancelPickElement' })?.catch(() => {});
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'cancelPickElement' })?.catch(() => {});
      });
    }
    sendResponse?.({ ok: true });
    return true;
  }

  // Content script: pick result – forward to sidepanel
  if (message.type === 'pickElementResult' && sender.tab?.id) {
    pickModeTabId = null;
    safeSendMessage({ type: 'pickElementResult', selector: message.selector, value: message.value });
    sendResponse?.({ ok: true });
    return true;
  }

  // Sidepanel: highlight element on page (hover list item)
  if (message.type === 'highlightElement') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'highlightElement',
          selector: message.selector,
          useFocused: message.useFocused,
        })?.catch(() => {});
      }
      try { sendResponse?.({ ok: true }); } catch (e) {}
    });
    return true;
  }

  if (message.type === 'clearHighlight') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'clearHighlight' })?.catch(() => {});
      }
      try { sendResponse?.({ ok: true }); } catch (e) {}
    });
    return true;
  }

  return false;
});

// When the side panel closes (Chrome's icon, our X, or any reason), its port disconnects → clear toggle state
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  port.onDisconnect.addListener(() => {
    sidePanelOpenTabId = null;
  });
});

// ============ ACTION (EXTENSION ICON) ============

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;
  if (sidePanelOpenTabId === tabId) {
    chrome.runtime.sendMessage({ type: 'requestClosePanel' }, (response) => {
      if (response?.closing) sidePanelOpenTabId = null;
    });
    return;
  }
  try {
    openSidePanel(tabId, tab.windowId);
    sidePanelOpenTabId = tabId;
  } catch {}
});

// ============ CONTEXT MENU SETUP ============

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // editable = input, textarea; page = anywhere (so <select> and other form fields get the menu)
    const menuContexts = ['editable', 'page'];

    // Parent menu
    chrome.contextMenus.create({
      id: 'lazy-forms-parent',
      title: ' Lazy forms',
      contexts: menuContexts,
    });

    // Quick slots (up to MAX_QUICK_SLOTS) - all matching entries
    for (let i = 0; i < MAX_QUICK_SLOTS; i++) {
      chrome.contextMenus.create({
        id: `lazy-forms-quick-${i}`,
        parentId: 'lazy-forms-parent',
        title: '(no match)',
        contexts: menuContexts,
        visible: false,
      });
    }

    // Separator
    chrome.contextMenus.create({
      id: 'lazy-forms-separator',
      parentId: 'lazy-forms-parent',
      type: 'separator',
      contexts: menuContexts,
    });

    // Add value
    chrome.contextMenus.create({
      id: 'lazy-forms-store',
      parentId: 'lazy-forms-parent',
      title: 'Add lazy forms value…',
      contexts: menuContexts,
    });

    // More
    chrome.contextMenus.create({
      id: 'lazy-forms-more',
      parentId: 'lazy-forms-parent',
      title: 'Open side panel…',
      contexts: menuContexts,
    });
  });

  // Inject content script into existing tabs
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && tab.url) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })?.catch(() => {});
      }
    });
  });
});

// ============ CONTEXT MENU CLICKS ============

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = info.menuItemId;
  if (!tab?.id) return;

  // Quick slots: apply value directly
  if (typeof id === 'string' && id.startsWith('lazy-forms-quick-')) {
    const slotIndex = parseInt(id.replace('lazy-forms-quick-', ''), 10);
    if (isNaN(slotIndex) || slotIndex < 0 || slotIndex >= MAX_QUICK_SLOTS) return;
    const entryId = quickSlots[slotIndex];
    if (!entryId) return;

    (async () => {
      const { entries } = await loadStorage();
      const entry = entries.find((e) => e.id === entryId);
      if (entry) {
        chrome.tabs.sendMessage(tab.id, { type: 'applyValue', value: entry.value })?.catch(() => {});
      }
    })();
    return;
  }

  // Store value: open sidepanel (must be synchronous for user gesture)
  if (id === 'lazy-forms-store') {
    try {
      openSidePanel(tab.id, tab.windowId);
      sidePanelOpenTabId = tab.id;
    } catch {}

    (async () => {
      let pageInfo = null;
      try {
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'getPageInfo' });
        if (reply?.ok) {
          pageInfo = {
            url: reply.url,
            origin: reply.origin,
            pathname: reply.pathname,
            selector: reply.selector,
            value: reply.value,
          };
        }
      } catch {}

      if (!pageInfo && tab.url?.startsWith('http')) {
        pageInfo = { ...pageInfoFromUrl(tab.url), value: '' };
      }

      if (pageInfo) {
        await chrome.storage.session.set({ [PENDING_STORE_KEY]: pageInfo });
        updatePageInfo(tab.id, pageInfo);
      }

      // Give sidepanel a moment to initialize, then refresh
      setTimeout(() => {
        refreshAll(tab.id);
      }, 100);
    })();
    return;
  }

  // More options: open sidepanel
  if (id === 'lazy-forms-more') {
    try {
      openSidePanel(tab.id, tab.windowId);
      sidePanelOpenTabId = tab.id;
    } catch {}
  }
});

// ============ CLEANUP ============

chrome.tabs.onRemoved.addListener((tabId) => {
  delete activeTabState[tabId];
});
