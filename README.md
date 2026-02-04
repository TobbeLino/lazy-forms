# Lazy forms

Chrome extension for context-aware storage of form field values. Right-click **inputs**, **textareas**, **dropdowns (select)**, or **contenteditable** areas (e.g. Gmail compose, rich text editors) to store or apply values as **plain text**.

## Features

- **Apply stored value**: Right-click a form field or contenteditable → Lazy forms → Apply stored value. A floating menu at the cursor lists matching values; click one to fill the field.
- **Store value**: Right-click a form field or contenteditable → Lazy forms → Store value → choose context (this field only, this page, this domain, or custom URL pattern). For dropdowns, the selected option’s value (or label) is stored. Contenteditable is supported as plain text only (no rich HTML).
- **Settings** (extension icon): List, delete, export/import entries as JSON.
- **More options** (context menu): Opens the side panel to view matching entries and apply from there.

## Context types

- **Input field**: Value applies only to this specific field on this page.
- **This URL**: Value applies to any matching field on this exact URL.
- **This domain**: Value applies to any matching field on this origin.
- **Custom**: Glob-style pattern (e.g. `*://*.google.com/*`). Matches full URL with * for any characters.

## Install

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `lazy-forms` folder

## Usage

1. On any page with a form field or contenteditable (e.g. email body), right-click the field.
2. Choose **Lazy forms** → **Apply stored value** to see matching values in a menu at the cursor; click one to apply (for selects, the option is chosen by value or label).
3. Choose **Store value** → **This domain** (or another context) to save the current value.
4. Click the extension icon to manage entries, export/import JSON, or edit/delete.
