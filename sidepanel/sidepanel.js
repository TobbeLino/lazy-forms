/**
 * Lazy forms side panel.
 * - Show all / current page toggle; Add value; list with Apply/Edit/Delete; settings (Import/Export).
 */

const STORAGE_KEY = 'lazyForms';
const PENDING_STORE_KEY = 'lazy-forms-pendingStore';

let currentState = null;
let currentSettings = null;
let showAllValues = false;
let addSectionVisible = false;
let showSettings = false;
let currentDragSectionKey = null;
let currentDraggedLi = null;
let currentGhost = null;
let aimModeActive = false;

// Port so background can detect when panel is closed (Chrome's icon, our X, etc.) and clear toggle state
try {
  chrome.runtime.connect({ name: 'sidepanel' });
} catch {}

function setAimModeActive(active) {
  aimModeActive = active;
  // Update all aim buttons to reflect active state
  document.querySelectorAll('.icon-btn-aim').forEach((btn) => {
    btn.classList.toggle('aim-active', active);
  });
}

function toggleAimMode() {
  if (aimModeActive) {
    chrome.runtime.sendMessage({ type: 'cancelPickElement' }).catch(() => {});
    setAimModeActive(false);
  } else {
    chrome.runtime.sendMessage({ type: 'startPickElement' }).catch(() => {});
    setAimModeActive(true);
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

function uuid() {
  return crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function applyValue(value, entry = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let selector = null;
  if (entry?.contextType === 'fieldOnly' && entry?.contextKey) {
    const parts = entry.contextKey.split('|');
    if (parts.length >= 3) selector = parts.slice(2).join('|');
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'applyValue', value, selector }).catch(() => {});
}

async function getStore() {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  return data[STORAGE_KEY] || { version: 1, entries: [] };
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getSettings' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      resolve(response.settings || null);
    });
  });
}

async function getPendingStore() {
  const data = await chrome.storage.session.get(PENDING_STORE_KEY);
  return data[PENDING_STORE_KEY] || null;
}

async function clearPendingStore() {
  await chrome.storage.session.remove(PENDING_STORE_KEY);
}

async function saveEntry(entry) {
  const store = await getStore();
  store.entries.push(entry);
  await chrome.storage.sync.set({ [STORAGE_KEY]: store });
}

async function updateEntry(id, updates) {
  const store = await getStore();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  store.entries[idx] = { ...store.entries[idx], ...updates };
  await chrome.storage.sync.set({ [STORAGE_KEY]: store });
}

async function deleteEntry(id) {
  const store = await getStore();
  store.entries = store.entries.filter((e) => e.id !== id);
  await chrome.storage.sync.set({ [STORAGE_KEY]: store });
}

function normalizeShortcutDisplay(shortcut) {
  if (!shortcut || typeof shortcut !== 'string') return 'Ctrl+Alt+L';
  const parts = shortcut.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return 'Ctrl+Alt+L';
  const last = parts[parts.length - 1];
  if (['Control', 'Ctrl', 'Shift', 'Alt', 'Meta'].includes(last)) {
    return 'Ctrl+Alt+L';
  }
  return parts.join('+');
}

async function saveSettingsFromPanel(partial) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'updateSettings', settings: partial }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      resolve(response.settings || null);
    });
  });
}

function groupBySpecificity(entries) {
  const groups = { fieldOnly: [], url: [], domain: [], all: [], pattern: [] };
  function sortOrder(a) {
    return a.order ?? a.createdAt ?? 0;
  }
  entries.forEach((e) => {
    if (e.contextType === 'fieldOnly') groups.fieldOnly.push(e);
    else if (e.contextType === 'url') groups.url.push(e);
    else if (e.contextType === 'domain') groups.domain.push(e);
    else if (e.contextType === 'all') groups.all.push(e);
    else groups.pattern.push(e);
  });
  Object.values(groups).forEach((arr) => {
    arr.sort((a, b) => sortOrder(a) - sortOrder(b));
  });
  return groups;
}

function buildContextKey(contextType, pageInfo) {
  if (!pageInfo) return '';
  const { url, origin, pathname, selector } = pageInfo;
  switch (contextType) {
    case 'fieldOnly': return `${origin}|${pathname}|${selector || ''}`;
    case 'url': return url || '';
    case 'domain': return origin || '';
    case 'all': return '*';
    default: return origin || '';
  }
}

const ICON_DRAG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
const ICON_APPLY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const ICON_AIM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';

function getPageInfoForAdd() {
  return currentState?.pageInfo || null;
}

function closeAddSection() {
  const addSection = document.getElementById('add-section');
  if (addSection) {
    addSection.classList.add('hidden');
    addSection.innerHTML = '';
  }
  addSectionVisible = false;
}

function renderAddForm(pendingStore, container) {
  const pageInfo = getPageInfoForAdd();
  const isPending = !!pendingStore;
  const value = pendingStore?.value ?? '';
  const label = pendingStore?.label ?? '';

  // Determine default type:
  // - From context menu with selector → fieldOnly
  // - From context menu without selector (or manual add) → url
  const hasSelector = !!(pendingStore?.selector || pageInfo?.selector);
  const defaultType = isPending && hasSelector ? 'fieldOnly' : 'url';

  container.innerHTML = '';
  const form = document.createElement('div');
  form.className = 'store-form store-form-add';
  form.innerHTML = `
    <h3 class="section-title">${isPending ? 'Store new value' : 'Add lazy forms value'}</h3>
    <label>Value
      <textarea id="store-value" rows="2">${escapeHtml(value)}</textarea>
    </label>
    <label>Label (optional)
      <input id="store-label" type="text" placeholder="Short label for menus" value="${escapeHtml(label)}" />
    </label>
    <label>Context
      <select id="store-context-type">
        <option value="fieldOnly" ${defaultType === 'fieldOnly' ? 'selected' : ''}>Input field</option>
        <option value="url" ${defaultType === 'url' ? 'selected' : ''}>This URL</option>
        <option value="domain">This domain</option>
        <option value="all">All sites</option>
        <option value="urlPattern">Custom</option>
      </select>
    </label>
    <label class="store-context-key-row">Context key / URL pattern
      <span class="store-context-key-input-wrap">
        <input id="store-context-key" type="text" placeholder="Leave empty to auto-fill" />
        <button type="button" id="store-aim-btn" class="icon-btn-aim" title="Pick field on page" aria-label="Pick field">${ICON_AIM}</button>
      </span>
      <span id="store-pattern-hint" class="context-pattern-hint hidden">URL: use * for any characters, e.g. <code>*://*.google.com/*</code>. Or use a selector (e.g. <code>#id</code>) to match that field on any site.</span>
    </label>
    <div class="store-actions">
      <button type="button" id="store-save">Save</button>
      <button type="button" id="store-cancel">Cancel</button>
    </div>
  `;
  container.appendChild(form);

  // Move initial focus to Save so a new value can quickly be added with Enter
  const initialSaveBtn = form.querySelector('#store-save');
  if (initialSaveBtn && typeof initialSaveBtn.focus === 'function') {
    initialSaveBtn.focus();
  }

  const keyInput = document.getElementById('store-context-key');
  const aimBtn = document.getElementById('store-aim-btn');
  const typeSelect = document.getElementById('store-context-type');
  const patternHint = document.getElementById('store-pattern-hint');

  // Track whether context key was manually edited (not auto-filled)
  let keyManuallyEdited = false;
  let updatingKeyProgrammatically = false;

  function updateKeyPlaceholderAndHint() {
    const isField = typeSelect?.value === 'fieldOnly';
    const isPattern = typeSelect?.value === 'urlPattern';
    if (aimBtn) aimBtn.style.display = isField ? 'inline-flex' : 'none';
    if (keyInput) {
      if (isField) keyInput.placeholder = 'origin|path|selector (auto-filled)';
      else if (isPattern) keyInput.placeholder = 'e.g. *://*.google.com/*';
      else keyInput.placeholder = 'Leave empty to auto-fill';
    }
    if (patternHint) patternHint.classList.toggle('hidden', !isPattern);
  }

  function autoFillContextKey() {
    if (!keyInput || !pageInfo) return;
    updatingKeyProgrammatically = true;
    keyInput.value = buildContextKey(typeSelect?.value || 'url', pageInfo);
    updatingKeyProgrammatically = false;
  }

  // Initial setup
  updateKeyPlaceholderAndHint();
  autoFillContextKey();

  // When type changes, update placeholder/hint and auto-fill context key
  // When switching to Custom, keep existing key if non-empty (often a small edit of another type)
  typeSelect?.addEventListener('change', () => {
    updateKeyPlaceholderAndHint();
    const newType = typeSelect?.value;
    const keyEmpty = !keyInput?.value?.trim();
    if (newType !== 'urlPattern' || keyEmpty) {
      autoFillContextKey();
      keyManuallyEdited = false;
    }
  });

  // When context key is manually edited, switch to Custom only if not already Input field
  // (so Input field entries can have their selector/key edited without changing type)
  keyInput?.addEventListener('input', () => {
    if (updatingKeyProgrammatically) return;
    keyManuallyEdited = true;
    if (typeSelect && typeSelect.value !== 'urlPattern' && typeSelect.value !== 'fieldOnly') {
      typeSelect.value = 'urlPattern';
      updateKeyPlaceholderAndHint();
    }
  });

  if (aimBtn) {
    aimBtn.addEventListener('click', toggleAimMode);
  }

  // Store reference so pickElementResult can update type
  container._typeSelect = typeSelect;
  container._keyInput = keyInput;
  container._updateKeyPlaceholderAndHint = updateKeyPlaceholderAndHint;
  container._setKeyManuallyEdited = (v) => { keyManuallyEdited = v; };
  container._setUpdatingKeyProgrammatically = (v) => { updatingKeyProgrammatically = v; };

  document.getElementById('store-cancel').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'cancelPickElement' }).catch(() => {});
    setAimModeActive(false);
    await clearPendingStore();
    closeAddSection();
    requestState();
  });

  document.getElementById('store-save').addEventListener('click', async () => {
    const valueInput = document.getElementById('store-value');
    const labelInput = document.getElementById('store-label');
    const typeSelectEl = document.getElementById('store-context-type');
    const keyInputEl = document.getElementById('store-context-key');
    const valueVal = valueInput?.value ?? '';
    const labelVal = labelInput?.value.trim() || undefined;
    const contextType = typeSelectEl?.value ?? 'domain';
    let contextKey = keyInputEl?.value.trim();
    if (!contextKey && pageInfo) contextKey = buildContextKey(contextType, pageInfo);
    const now = Date.now();
    await saveEntry({
      id: uuid(),
      value: valueVal,
      label: labelVal,
      contextType,
      contextKey: contextKey || '*',
      createdAt: now,
      order: now,
    });
    chrome.runtime.sendMessage({ type: 'cancelPickElement' }).catch(() => {});
    setAimModeActive(false);
    await clearPendingStore();
    closeAddSection();
    requestState();
  });
}

let renderInProgress = false;
let pendingRenderState = null;

async function render(state) {
  if (renderInProgress) {
    pendingRenderState = state;
    return;
  }
  renderInProgress = true;
  try {
    await doRender(state);
  } finally {
    renderInProgress = false;
    if (pendingRenderState !== null) {
      const next = pendingRenderState;
      pendingRenderState = null;
      render(next);
    }
  }
}

async function doRender(state) {
  currentState = state;
  const list = document.getElementById('matching-list');
  const empty = document.getElementById('empty-state');
  const subtitle = document.getElementById('subtitle');
  const addSection = document.getElementById('add-section');

  if (!list || !empty) return;

  if (subtitle) {
    subtitle.textContent = showAllValues
      ? 'All stored lazy values'
      : 'Stored lazy values for this page / field';
  }

  const pendingStore = await getPendingStore();
  if (pendingStore && state?.pageInfo) {
    setSettingsView(false); // If settings were open, show main view so the add form is visible
    addSectionVisible = true;
    addSection.classList.remove('hidden');
    renderAddForm(pendingStore, addSection);
  }

  const entriesToShow = showAllValues ? (state?.entries || []) : (state?.matches || []);
  list.innerHTML = '';

  if (!entriesToShow.length) {
    empty.classList.remove('hidden');
    empty.innerHTML = showAllValues
      ? 'No lazy values yet.<br>Add one or use the context menu.'
      : 'No lazy values match.<br>Add one or use the context menu.';
    return;
  }
  empty.classList.add('hidden');

  const groups = groupBySpecificity(entriesToShow);
  const sections = [
    { key: 'fieldOnly', title: 'Input field' },
    { key: 'url', title: 'This URL' },
    { key: 'domain', title: 'This domain' },
    { key: 'all', title: 'All sites' },
    { key: 'pattern', title: 'Other patterns' },
  ];

  sections.forEach(({ key, title }) => {
    const items = groups[key];
    if (!items.length) return;
    const header = document.createElement('h3');
    header.className = 'section-title';
    header.textContent = title;
    list.appendChild(header);
    items.forEach((entry) => {
      const li = document.createElement('li');
      li.className = 'entry-item';
      li.dataset.entryId = entry.id;
      li.dataset.sectionKey = key;
      const base = entry.label || entry.value || '';
      const preview = base.length > 36 ? base.slice(0, 33) + '…' : base;
      li.innerHTML = `
        <div class="entry-row" data-entry-id="${escapeHtml(entry.id)}">
          <span class="drag-handle" title="Drag to reorder">${ICON_DRAG}</span>
          <span class="value-preview" title="${escapeHtml(entry.value)}">${escapeHtml(preview)}</span>
          <div class="entry-actions">
            <button type="button" class="icon-btn-item apply-icon-btn" title="Apply">${ICON_APPLY}</button>
            <button type="button" class="icon-btn-item edit-icon-btn" title="Edit">${ICON_EDIT}</button>
            <button type="button" class="icon-btn-item delete-icon-btn" title="Delete">${ICON_DELETE}</button>
          </div>
        </div>
      `;
      const row = li.querySelector('.entry-row');
      row.addEventListener('click', (e) => {
        if (e.target.closest('.edit-icon-btn') || e.target.closest('.delete-icon-btn') || e.target.closest('.drag-handle')) return;
        applyValue(entry.value, entry);
      });
      li.querySelector('.apply-icon-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        applyValue(entry.value, entry);
      });
      li.querySelector('.edit-icon-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openEditForm(li, entry);
      });
      li.querySelector('.delete-icon-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const label = entry.label || entry.value || 'this value';
        const short = String(label).slice(0, 40) + (String(label).length > 40 ? '…' : '');
        if (!confirm(`Delete "${short}"?`)) return;
        deleteEntry(entry.id).then(() => requestState());
      });
      li.querySelector('.drag-handle').addEventListener('click', (e) => e.stopPropagation());
      setupDragAndDrop(li, entry, key, list);
      li.addEventListener('mouseenter', () => {
        if (entry.contextType === 'fieldOnly' && entry.contextKey) {
          const parts = entry.contextKey.split('|');
          const selector = parts.length >= 3 ? parts.slice(2).join('|') : entry.contextKey;
          chrome.runtime.sendMessage({ type: 'highlightElement', selector }).catch(() => {});
        } else {
          chrome.runtime.sendMessage({ type: 'highlightElement', useFocused: true }).catch(() => {});
        }
      });
      li.addEventListener('mouseleave', () => {
        chrome.runtime.sendMessage({ type: 'clearHighlight' }).catch(() => {});
      });
      list.appendChild(li);
    });
  });
}

function setupDragAndDrop(li, entry, sectionKey, list) {
  const row = li.querySelector('.entry-row');
  const handle = li.querySelector('.drag-handle');
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    currentDragSectionKey = sectionKey;
    currentDraggedLi = li;
    document.body.classList.add('is-dragging');
    row.classList.add('dragging');
    const ghost = row.cloneNode(true);
    ghost.classList.add('entry-drag-ghost');
    ghost.style.cssText = `position:fixed;left:${e.clientX - offsetX}px;top:${e.clientY - offsetY}px;width:${rect.width}px;pointer-events:none;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.12);border-radius:4px;background:#fff`;
    document.body.appendChild(ghost);
    currentGhost = ghost;
    const onMove = (moveEvent) => {
      ghost.style.left = (moveEvent.clientX - offsetX) + 'px';
      ghost.style.top = (moveEvent.clientY - offsetY) + 'px';
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const overLi = under?.closest('li.entry-item');
      if (!overLi || overLi.classList.contains('entry-placeholder') || overLi.dataset.sectionKey !== sectionKey) return;
      if (overLi === li) return;
      const r = overLi.getBoundingClientRect();
      const centerY = r.top + r.height / 2;
      const insertBeforeNode = moveEvent.clientY < centerY ? overLi : overLi.nextElementSibling;
      if (li.nextElementSibling === insertBeforeNode) return;
      list.insertBefore(li, insertBeforeNode);
    };
    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (currentGhost?.parentNode) currentGhost.remove();
      currentGhost = null;
      document.body.classList.remove('is-dragging');
      currentDraggedLi?.querySelector('.entry-row')?.classList.remove('dragging');
      if (currentDraggedLi) {
        try {
          const dragSection = currentDragSectionKey;
          if (dragSection) {
            const sectionItems = [...list.querySelectorAll(`li.entry-item[data-section-key="${dragSection}"]`)].filter((el) => !el.classList.contains('entry-placeholder'));
            const store = await getStore();
            for (let idx = 0; idx < sectionItems.length; idx++) {
              const id = sectionItems[idx].dataset.entryId;
              const ent = store.entries.find((e) => e.id === id);
              if (ent) await updateEntry(id, { order: idx });
            }
            requestState();
          }
        } catch (err) {
          console.warn('Drag drop error', err);
        }
      }
      currentDragSectionKey = null;
      currentDraggedLi = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function openEditForm(li, entry) {
  closeAddSection();
  document.querySelectorAll('.entry-edit-form').forEach((el) => {
    const listItem = el.closest('li.entry-item');
    const row = listItem?.querySelector('.entry-row');
    if (row) row.classList.remove('hidden');
    el.remove();
  });
  const row = li.querySelector('.entry-row');
  if (row) row.classList.add('hidden');
  const formWrap = document.createElement('div');
  formWrap.className = 'entry-edit-form store-form store-form-add';
  const pageInfo = getPageInfoForAdd();
  formWrap.innerHTML = `
    <h3 class="section-title">Edit lazy forms value</h3>
    <label>Value
      <textarea class="edit-value" rows="2">${escapeHtml(entry.value)}</textarea>
    </label>
    <label>Label (optional)
      <input class="edit-label" type="text" placeholder="Short label" value="${escapeHtml(entry.label ?? '')}" />
    </label>
    <label>Context
      <select class="edit-context-type">
        <option value="fieldOnly" ${entry.contextType === 'fieldOnly' ? 'selected' : ''}>Input field</option>
        <option value="url" ${entry.contextType === 'url' ? 'selected' : ''}>This URL</option>
        <option value="domain" ${entry.contextType === 'domain' ? 'selected' : ''}>This domain</option>
        <option value="all" ${entry.contextType === 'all' ? 'selected' : ''}>All sites</option>
        <option value="urlPattern" ${entry.contextType === 'urlPattern' ? 'selected' : ''}>Custom</option>
      </select>
    </label>
    <label class="store-context-key-row">Context key / URL pattern
      <span class="store-context-key-input-wrap">
        <input class="edit-context-key" type="text" placeholder="e.g. *://*.google.com/*" value="${escapeHtml(entry.contextKey ?? '')}" />
        <button type="button" class="edit-aim-btn icon-btn-aim" title="Pick field on page">${ICON_AIM}</button>
      </span>
      <span class="edit-pattern-hint context-pattern-hint ${entry.contextType === 'urlPattern' ? '' : 'hidden'}">URL: use * for any characters, e.g. <code>*://*.google.com/*</code>. Or use a selector (e.g. <code>#id</code>) to match that field on any site.</span>
    </label>
    <div class="store-actions">
      <button type="button" class="edit-save-btn">Save</button>
      <button type="button" class="edit-cancel-btn">Cancel</button>
    </div>
  `;
  li.appendChild(formWrap);
  const aimBtn = formWrap.querySelector('.edit-aim-btn');
  const typeSelect = formWrap.querySelector('.edit-context-type');
  const editKeyInput = formWrap.querySelector('.edit-context-key');
  const editPatternHint = formWrap.querySelector('.edit-pattern-hint');

  // Track manual editing
  formWrap._keyManuallyEdited = false;
  formWrap._updatingKeyProgrammatically = false;

  function updateKeyPlaceholderAndHint() {
    const isField = typeSelect?.value === 'fieldOnly';
    const isPattern = typeSelect?.value === 'urlPattern';
    if (aimBtn) aimBtn.style.display = isField ? 'inline-flex' : 'none';
    if (editKeyInput) {
      if (isField) editKeyInput.placeholder = 'origin|path|selector';
      else if (isPattern) editKeyInput.placeholder = 'e.g. *://*.google.com/*';
      else editKeyInput.placeholder = '';
    }
    if (editPatternHint) editPatternHint.classList.toggle('hidden', !isPattern);
  }
  formWrap._updateKeyPlaceholderAndHint = updateKeyPlaceholderAndHint;

  function autoFillContextKey() {
    if (!editKeyInput || !pageInfo) return;
    formWrap._updatingKeyProgrammatically = true;
    editKeyInput.value = buildContextKey(typeSelect?.value || 'url', pageInfo);
    formWrap._updatingKeyProgrammatically = false;
  }

  updateKeyPlaceholderAndHint();

  // When type changes, update placeholder/hint and auto-fill context key
  // When switching to Custom, keep existing key if non-empty (often a small edit of another type)
  typeSelect?.addEventListener('change', () => {
    updateKeyPlaceholderAndHint();
    const newType = typeSelect?.value;
    const keyEmpty = !editKeyInput?.value?.trim();
    if (newType !== 'urlPattern' || keyEmpty) {
      autoFillContextKey();
      formWrap._keyManuallyEdited = false;
    }
  });

  // When context key is manually edited, switch to Custom only if not already Input field
  editKeyInput?.addEventListener('input', () => {
    if (formWrap._updatingKeyProgrammatically) return;
    formWrap._keyManuallyEdited = true;
    if (typeSelect && typeSelect.value !== 'urlPattern' && typeSelect.value !== 'fieldOnly') {
      typeSelect.value = 'urlPattern';
      updateKeyPlaceholderAndHint();
    }
  });

  if (aimBtn) aimBtn.addEventListener('click', toggleAimMode);
  formWrap.querySelector('.edit-cancel-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'cancelPickElement' }).catch(() => {});
    setAimModeActive(false);
    formWrap.remove();
    if (row) row.classList.remove('hidden');
  });
  formWrap.querySelector('.edit-save-btn').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'cancelPickElement' }).catch(() => {});
    setAimModeActive(false);
    const value = formWrap.querySelector('.edit-value').value;
    const label = formWrap.querySelector('.edit-label').value.trim() || undefined;
    const contextType = formWrap.querySelector('.edit-context-type').value;
    let contextKey = formWrap.querySelector('.edit-context-key').value.trim();
    if (!contextKey && pageInfo) contextKey = buildContextKey(contextType, pageInfo);
    await updateEntry(entry.id, { value, label, contextType, contextKey: contextKey || '*' });
    formWrap.remove();
    if (row) row.classList.remove('hidden');
    requestState();
  });
}

function setSettingsView(visible) {
  showSettings = visible;
  const mainView = document.getElementById('main-view');
  const settingsView = document.getElementById('settings-view');
  if (mainView) mainView.classList.toggle('hidden', visible);
  if (settingsView) settingsView.classList.toggle('hidden', !visible);
}

function applySettingsToUi() {
  const showIconCheckbox = document.getElementById('setting-show-icon');
  const showIconPageCheckbox = document.getElementById('setting-show-icon-page');
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!currentSettings) return;
  if (showIconCheckbox) {
    showIconCheckbox.checked = !!currentSettings.showFieldIcon;
  }
  if (showIconPageCheckbox) {
    showIconPageCheckbox.checked = !!currentSettings.showIconOnPageValues;
  }
  if (shortcutDisplay) {
    shortcutDisplay.textContent = normalizeShortcutDisplay(currentSettings.shortcutOpenMenu);
  }
}

function requestState() {
  chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.ok && response.state) {
      render(response.state);
    } else {
      render(null);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const viewThisPageBtn = document.getElementById('view-this-page');
  const viewAllBtn = document.getElementById('view-all');
  const addValueBtn = document.getElementById('add-value-btn');
  const addSection = document.getElementById('add-section');
  function setViewTabsActive() {
    if (viewThisPageBtn) {
      viewThisPageBtn.classList.toggle('active', !showAllValues);
      viewThisPageBtn.setAttribute('aria-selected', !showAllValues);
    }
    if (viewAllBtn) {
      viewAllBtn.classList.toggle('active', showAllValues);
      viewAllBtn.setAttribute('aria-selected', showAllValues);
    }
  }
  if (viewThisPageBtn) {
    viewThisPageBtn.addEventListener('click', () => {
      showAllValues = false;
      setViewTabsActive();
      if (currentState) render(currentState);
    });
  }
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', () => {
      showAllValues = true;
      setViewTabsActive();
      if (currentState) render(currentState);
    });
  }
  setViewTabsActive();
  if (addValueBtn && addSection) {
    addValueBtn.addEventListener('click', () => {
      document.querySelectorAll('.entry-edit-form').forEach((el) => el.remove());
      addSectionVisible = true;
      addSection.classList.remove('hidden');
      renderAddForm(null, addSection);
    });
  }
  const settingsBtn = document.getElementById('settings-btn');
  const settingsBackBtn = document.getElementById('settings-back-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => setSettingsView(true));
  if (settingsBackBtn) settingsBackBtn.addEventListener('click', () => setSettingsView(false));

  const closePanelBtn = document.getElementById('close-panel-btn');
  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'closeSidePanel' }).catch(() => {});
      window.close();
    });
  }

  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const store = await getStore();
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lazy-forms-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          if (!parsed.entries || !Array.isArray(parsed.entries)) {
            alert('Invalid format: expected { entries: [...] }');
            return;
          }
          await chrome.storage.sync.set({ [STORAGE_KEY]: { version: parsed.version ?? 1, entries: parsed.entries } });
          requestState();
        } catch (err) {
          alert('Invalid JSON: ' + err.message);
        }
      };
      input.click();
    });
  }

  const SETTINGS_KEYS = ['showFieldIcon', 'showIconOnPageValues', 'shortcutOpenMenu'];
  const exportSettingsBtn = document.getElementById('export-settings-btn');
  const importSettingsBtn = document.getElementById('import-settings-btn');
  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener('click', async () => {
      const settings = currentSettings || (await getSettings()) || {};
      const toExport = {};
      SETTINGS_KEYS.forEach((k) => {
        if (settings[k] !== undefined) toExport[k] = settings[k];
      });
      const blob = new Blob([JSON.stringify({ settings: toExport }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lazy-forms-settings.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  if (importSettingsBtn) {
    importSettingsBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const raw = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
          const toApply = {};
          SETTINGS_KEYS.forEach((k) => {
            if (raw[k] !== undefined) toApply[k] = raw[k];
          });
          if (Object.keys(toApply).length === 0) {
            alert('Invalid format: expected { settings: { ... } } or settings object with showFieldIcon, shortcutOpenMenu, etc.');
            return;
          }
          const next = await saveSettingsFromPanel(toApply);
          if (next) {
            currentSettings = next;
            applySettingsToUi();
          }
        } catch (err) {
          alert('Invalid JSON: ' + err.message);
        }
      };
      input.click();
    });
  }

  const showIconCheckbox = document.getElementById('setting-show-icon');
  const showIconPageCheckbox = document.getElementById('setting-show-icon-page');
  const shortcutEditBtn = document.getElementById('shortcut-edit-btn');
  const shortcutResetBtn = document.getElementById('shortcut-reset-btn');
  const shortcutHint = document.getElementById('shortcut-hint');

  if (showIconCheckbox) {
    showIconCheckbox.addEventListener('change', async () => {
      const next = await saveSettingsFromPanel({ showFieldIcon: showIconCheckbox.checked });
      if (next) {
        currentSettings = next;
        applySettingsToUi();
      }
    });
  }
  if (showIconPageCheckbox) {
    showIconPageCheckbox.addEventListener('change', async () => {
      const next = await saveSettingsFromPanel({ showIconOnPageValues: showIconPageCheckbox.checked });
      if (next) {
        currentSettings = next;
        applySettingsToUi();
      }
    });
  }

  if (shortcutEditBtn && shortcutHint) {
    shortcutEditBtn.addEventListener('click', () => {
      if (!shortcutHint.classList.contains('hidden')) return;
      shortcutHint.classList.remove('hidden');
      const onKeyDown = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKeyDown, true);
          shortcutHint.classList.add('hidden');
          return;
        }
        // Ignore pure modifier presses; wait for a real key while modifiers are held
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
          return;
        }
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        if (e.metaKey) parts.push('Meta');
        const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (!parts.length) {
          // Require at least one modifier to avoid stealing normal typing keys
          return;
        }
        parts.push(key);
        const shortcut = parts.join('+');
        document.removeEventListener('keydown', onKeyDown, true);
        shortcutHint.classList.add('hidden');
        const next = await saveSettingsFromPanel({ shortcutOpenMenu: shortcut });
        if (next) {
          currentSettings = next;
          applySettingsToUi();
        }
      };
      document.addEventListener('keydown', onKeyDown, true);
    });
  }

  if (shortcutResetBtn) {
    shortcutResetBtn.addEventListener('click', async () => {
      const next = await saveSettingsFromPanel({ shortcutOpenMenu: 'Ctrl+Alt+L' });
      if (next) {
        currentSettings = next;
        applySettingsToUi();
      }
    });
  }

  getSettings().then((settings) => {
    if (settings) {
      currentSettings = settings;
      applySettingsToUi();
    }
    requestState();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'requestClosePanel') {
    sendResponse?.({ closing: true });
    chrome.runtime.sendMessage({ type: 'panelClosing' }).catch(() => {});
    window.close();
    return true;
  }
  if (message.type === 'stateUpdated') {
    render(message.state);
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'settingsUpdated') {
    currentSettings = message.settings || currentSettings;
    applySettingsToUi();
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'resetAimMode') {
    setAimModeActive(false);
    sendResponse?.({ ok: true });
    return true;
  }
  if (message.type === 'pickElementResult') {
    const pageInfo = getPageInfoForAdd();
    if (pageInfo && message.selector) {
      const contextKey = `${pageInfo.origin}|${pageInfo.pathname}|${message.selector}`;

      // Update add form
      const addSection = document.getElementById('add-section');
      const addKeyInput = document.getElementById('store-context-key');
      const addTypeSelect = addSection?._typeSelect;
      if (addKeyInput) {
        addSection?._setUpdatingKeyProgrammatically?.(true);
        addKeyInput.value = contextKey;
        addSection?._setUpdatingKeyProgrammatically?.(false);
        addSection?._setKeyManuallyEdited?.(false);
      }
      if (addTypeSelect && addTypeSelect.value !== 'fieldOnly') {
        addTypeSelect.value = 'fieldOnly';
        addSection?._updateKeyPlaceholderAndHint?.();
      }

      // Update edit form if open
      const editForm = document.querySelector('.entry-edit-form');
      const editKeyInput = editForm?.querySelector('.edit-context-key');
      const editTypeSelect = editForm?.querySelector('.edit-context-type');
      if (editKeyInput) {
        editForm._updatingKeyProgrammatically = true;
        editKeyInput.value = contextKey;
        editForm._updatingKeyProgrammatically = false;
        editForm._keyManuallyEdited = false;
      }
      if (editTypeSelect && editTypeSelect.value !== 'fieldOnly') {
        editTypeSelect.value = 'fieldOnly';
        editForm?._updateKeyPlaceholderAndHint?.();
      }

      // Clear aim mode since we got a result
      setAimModeActive(false);
    }
    sendResponse?.({ ok: true });
    return true;
  }
  return false;
});

window.addEventListener('beforeunload', () => {
  chrome.runtime.sendMessage({ type: 'panelClosing' }).catch(() => {});
});
