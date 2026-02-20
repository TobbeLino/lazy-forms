# Lazy forms

Browser extension (Chrome and Firefox) for context-aware storage of form field values. Right-click **inputs**, **textareas**, **dropdowns (select)**, or **contenteditable** areas (e.g. Gmail compose, rich text editors) to store or apply values as **plain text**. Data is stored in the browser’s sync storage (Chrome: syncs across devices when signed in; Firefox: same when using a Firefox account).

## Features

- **Apply stored value**: Right-click a form field or contenteditable → **Lazy forms** → **Apply stored value**. A floating menu at the cursor lists matching values; click one to fill the field. The context menu also shows up to 10 matching entries as quick-apply items (with optional shortcut shown).
- **Store value**: Right-click a form field or contenteditable → **Lazy forms** → **Store value** → choose context (this field only, this page, this domain, or custom URL pattern). For dropdowns, the selected option’s value (or label) is stored. Contenteditable is supported as plain text only (no rich HTML).
- **Side panel**: Click the extension icon or press **Ctrl+Alt+K** (configurable) to open the side panel. View matching vs all values, add/edit/delete entries, export/import JSON, and change settings.
- **More options** (context menu): Opens the side panel to view matching entries and apply from there.

### Keyboard shortcuts

- **Floating menu** (default **Ctrl+Alt+L**): When focus is in a form field, press to open the floating menu at that field. Configurable in the side panel.
- **Side panel** (default **Ctrl+Alt+K**): Open the side panel from anywhere. Configurable in the side panel.
- **Per-entry shortcuts**: When adding or editing a value, you can assign an optional shortcut (e.g. Ctrl+Alt+1). When focus is in any form field, pressing that shortcut pastes that value into the field (works in any field, regardless of context match).

### Optional: inline field icon

In **Settings** (side panel) you can enable:
- **Show icon on matching input elements** – a small icon (≡) appears on fields that have matching stored values; click it to open the floating menu.
- **Show icon on matching page** – show the icon on any field when the page has matching values (e.g. URL/domain-level), not only field-specific ones.

## Context types

- **Input field**: Value applies only to this specific field on this page.
- **This URL**: Value applies to any matching field on this exact URL.
- **This domain**: Value applies to any matching field on this origin.
- **All sites**: Value applies to any matching field on any page.
- **Custom**: Glob-style pattern (e.g. `*://*.google.com/*`). Matches full URL with * for any characters.

## Install

**Firefox** (142 or newer for data collection consent; 115+ for local/testing)
1. Run `npm run build:firefox` (copies `manifest.firefox.json` → `manifest.json` and builds to ./dist/).
2. Open `about:debugging` → "This Firefox" → "Load Temporary Add-on…" → select the `lazy-forms` folder.

**Chrome**
1. Run `npm run build:chrome` (copies `manifest.chrome.json` → `manifest.json`, and zips to ./dist).
2. Open `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select the `lazy-forms` folder.

If you see errors in Chrome like *"background.scripts requires manifest version 2"* or *"Unrecognized manifest key sidebar_action"*, the wrong manifest is active: run **`npm run build:chrome`** and reload the extension.

**Use both browsers at once**
Run **`npm run build`** to create two folders: `dist/chrome/` and `dist/firefox/`. Load `dist/chrome` in Chrome (Load unpacked) and `dist/firefox` in Firefox (Load Temporary Add-on). Re-run after code changes.

## Usage

1. On any page with a form field or contenteditable (e.g. email body), right-click the field.
2. Choose **Lazy forms** → **Apply stored value** to see matching values in a menu at the cursor; click one to apply (for selects, the option is chosen by value or label). Or use a per-entry shortcut if you assigned one.
3. Choose **Store value** → **This domain** (or another context) to save the current value.
4. Click the extension icon or press **Ctrl+Alt+K** to open the side panel and manage entries, export/import, or change settings.
