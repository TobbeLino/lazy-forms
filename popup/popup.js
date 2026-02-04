const STORAGE_KEY = 'lazyForms';

async function loadEntries() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  if (!data || !Array.isArray(data.entries)) {
    return [];
  }
  return data.entries;
}

function renderEntries(entries) {
  const list = document.getElementById('entries-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '';

  if (entries.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  entries.forEach((entry) => {
    const li = document.createElement('li');
    const preview = entry.value.length > 40 ? entry.value.slice(0, 37) + '…' : entry.value;
    li.innerHTML = `
      <span class="value-preview" title="${escapeHtml(entry.value)}">${escapeHtml(entry.label || preview)}</span>
      <span class="context-badge">${entry.contextType}</span>
      <div class="entry-actions">
        <button class="edit-btn" data-id="${escapeHtml(entry.id)}">Edit</button>
        <button class="delete-btn" data-id="${escapeHtml(entry.id)}">Delete</button>
      </div>
    `;
    li.querySelector('.edit-btn').addEventListener('click', () => editEntry(entry.id));
    li.querySelector('.delete-btn').addEventListener('click', () => {
      const label = entry.label || entry.value || 'this value';
      const short = String(label).slice(0, 40) + (String(label).length > 40 ? '…' : '');
      if (!confirm(`Delete "${short}"?`)) return;
      deleteEntry(entry.id);
    });
    list.appendChild(li);
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function deleteEntry(id) {
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const store = data[STORAGE_KEY] || { version: 1, entries: [] };
  store.entries = store.entries.filter((e) => e.id !== id);
  await chrome.storage.sync.set({ [STORAGE_KEY]: store });
  const entries = await loadEntries();
  renderEntries(entries);
}

let editingId = null;

async function editEntry(id) {
  const entries = await loadEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  editingId = id;
  document.getElementById('edit-value').value = entry.value;
  document.getElementById('edit-label').value = entry.label ?? '';
  document.getElementById('edit-context-type').value = entry.contextType;
  document.getElementById('edit-context-key').value = entry.contextKey;
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function saveEdit() {
  if (editingId == null) return;
  const value = document.getElementById('edit-value').value;
  const label = document.getElementById('edit-label').value.trim() || undefined;
  const contextType = document.getElementById('edit-context-type').value;
  const contextKey = document.getElementById('edit-context-key').value.trim();
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const store = data[STORAGE_KEY] || { version: 1, entries: [] };
  const idx = store.entries.findIndex((e) => e.id === editingId);
  if (idx === -1) return;
  store.entries[idx] = {
    ...store.entries[idx],
    value,
    label: label || undefined,
    contextType,
    contextKey,
  };
  await chrome.storage.sync.set({ [STORAGE_KEY]: store });
  editingId = null;
  document.getElementById('edit-modal').classList.add('hidden');
  const entries = await loadEntries();
  renderEntries(entries);
}

function closeEditModal() {
  editingId = null;
  document.getElementById('edit-modal').classList.add('hidden');
}

document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
document.getElementById('edit-save').addEventListener('click', saveEdit);
document.getElementById('edit-modal').addEventListener('click', (e) => {
  if (e.target.id === 'edit-modal') closeEditModal();
});

document.getElementById('export-btn').addEventListener('click', async () => {
  const entries = await loadEntries();
  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const store = data[STORAGE_KEY] || { version: 1, entries: [] };
  const json = JSON.stringify(store, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lazy-forms-config.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-btn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = JSON.parse(text);
      if (!parsed.entries || !Array.isArray(parsed.entries)) {
        alert('Invalid format: expected { entries: [...] }');
        return;
      }
      await chrome.storage.sync.set({ [STORAGE_KEY]: { version: parsed.version ?? 1, entries: parsed.entries } });
      const entries = await loadEntries();
      renderEntries(entries);
    } catch (err) {
      alert('Invalid JSON: ' + err.message);
    }
  };
  input.click();
});

loadEntries().then(renderEntries);
