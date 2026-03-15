# 📊 SpreadsheetApp — WorkElate Internship Submission

A React + Vite spreadsheet with a custom formula engine. This submission implements three production-grade features: Column Sort & Filter, Multi-Cell Copy/Paste, and LocalStorage Persistence.

---

## 🎥 Feature Walkthrough Video

> **📽️ Watch the full recorded explanation of all features implemented:**
> ### 👉 [Click here to watch the Loom recording](https://www.loom.com/share/c9f196f557dd43eaa5df55cfb119c5fa)
>
> This video walks through all three features — Column Sort & Filter, Multi-Cell Copy/Paste, and LocalStorage Persistence — with a live demo and explanation of the key design decisions made during implementation.

---

## 🚀 Getting Started

```bash
npm install
npm run dev   # → http://localhost:5173
```

---

## ✅ Features Implemented

### Task 1 — Column Sort & Filter

**How to use:**
- **Click a column header label** (e.g., `A`, `B`) to sort: Ascending → Descending → None (3-way toggle).
- **Click the `▾` icon** on any column header to open an Excel-style filter dropdown.
- In the dropdown, uncheck values to hide rows containing them. Click **"Select All"** to clear the filter for that column.
- A **"✕ Clear Sort & Filters"** button appears in the top header bar when any sort/filter is active.

**Key Decisions:**

| Decision | Rationale |
|---|---|
| **View-layer only sorting** | The `visibleRows` array (a `useMemo` over row indices) is what gets sorted/filtered. The engine's cell data at `[r, c]` is **never moved**, so formula references like `=A1+B1` always point to the correct underlying data. |
| **Sort on computed values** | `engine.getCell(r, col).computed` is used for sorting, so if a cell contains `=SUM(A1:A5)`, sorting uses the *result* (e.g., `150`), not the formula string. |
| **Filter hides, not deletes** | Filtered rows simply have their indices excluded from `visibleRows`. The data remains intact and restores when the filter is cleared. |
| **Reversible** | Clearing all filters returns to the original order because the engine data was never changed. |

---

### Task 2 — Multi-Cell Copy & Paste

**How to use:**
- **Click** a cell to select it. **Drag** or **Shift+Click** to select a range (shows blue highlight).
- **Ctrl+C** copies computed values as TSV (Tab-Separated Values) — the same format Excel and Google Sheets use.
- **Ctrl+V** pastes TSV data starting at the top-left of the current selection. Works with content copied from **Excel or Google Sheets**.
- **Delete** or **Backspace** clears all cells in the current selection.
- **Ctrl+Z** undoes an entire multi-cell paste in a **single step**.

**Key Decisions:**

| Decision | Rationale |
|---|---|
| **Range Selection Model** | Tracks `{ anchor, active }` — the corner where the mouse went down, and the corner it dragged to. `selectionRange` is derived by clamping min/max of both. This mirrors how Excel internally represents a selection. |
| **TSV format for clipboard** | Tab (`\t`) separates columns, newline (`\n`) separates rows. This is the standard interchange format recognized by Excel, Google Sheets, and LibreOffice Calc. |
| **Ctrl+C copies computed values** | Per the spec: if a cell has `=SUM(A1:A5)`, we copy `150`, not `=SUM(A1:A5)`. Preserving formula semantics across apps is not possible, so computed values are the correct choice. |
| **`batchSetCells` in engine** | A new public API added to `core.js`. It captures *all* previous values before making *any* changes, and pushes a single `{ type: 'batch', changes: [...] }` entry to the undo stack. One Ctrl+Z undoes the entire paste. |
| **`navigator.clipboard` API** | Used for cross-app compatibility. Falls back to an internal clipboard ref if the Clipboard API is denied (e.g., non-HTTPS). |

---

### Task 3 — Local Storage Persistence

**How it works:**
- Any change (typing, paste, formatting) triggers an auto-save after **500ms of inactivity** (debounced).
- On page reload, the app reads `localStorage` and restores all cell values, formulas, styles, and grid dimensions before the first render.
- Undo/redo history is **not** persisted — clearing the page gives a fresh undo stack while keeping your data.

**Key Decisions:**

| Decision | Rationale |
|---|---|
| **Schema versioning** | The `exportState()` function writes `{ version: 1, rows, cols, cells }`. On load, `importState()` rejects data with a mismatched version number, preventing crashes from format changes. |
| **Error recovery** | The load is wrapped in `try/catch`. If the data is corrupted (e.g., truncated JSON), it is silently discarded and `localStorage.removeItem()` is called to clear the bad data. |
| **Size check before save** | Before writing, the serialized string length is checked against ~4.5MB (below the typical 5MB quota). Oversized data is skipped with a console warning. |
| **Styles persisted separately** | Cell styles (`bold`, `italic`, `bg`, `color`, etc.) live in React state as `cellStyles`, so they are saved alongside engine data in a single JSON object. |
| **Undo/redo NOT persisted** | The undo stack lives in the engine's closure. It is not exported, so reloading the page starts with a clean history — which is the expected behavior (you can't Ctrl+Z changes from a previous session). |

---

## 🏗️ Architecture & Key Design Choices

```
src/
├── engine/
│   └── core.js       ← Pure JS formula engine (no React). Handles:
│                        - Cell storage (Map), dependency graph, computed cache
│                        - Formula parsing (tokenizer → AST → evaluator)
│                        - Undo/Redo with full batch support
│                        - Serialization: exportState() / importState()
├── App.jsx           ← All UI & state. Handles:
│                        - Range Selection model (anchor + active)
│                        - View-layer Sort & Filter (visibleRows useMemo)
│                        - Clipboard API integration
│                        - Auto-save to localStorage (debounced useEffect)
└── App.css           ← Styles for selection highlight, sort indicators,
                         filter dropdowns
```

**Engine is completely decoupled from React.** `App.jsx` holds a single `engine` instance and calls its public API. When the engine state changes, `forceRerender()` increments a `version` counter which invalidates memoized values.

---

## 📦 Tech Stack

- **React 19** — UI rendering
- **Vite 7** — Build tool & dev server
- **Vanilla JS** — Custom formula engine (`core.js`) with zero dependencies
- **Web Clipboard API** — Native browser clipboard for cross-app paste
- **Web Storage API** — `localStorage` for persistence

---

## ⚠️ Known Limitations & Edge Cases Handled

- **Circular references** detected by the dependency graph → displays `#CYCLE!`
- **Division by zero** → displays `#VALUE!`
- **Invalid cell references** → displays `#REF!`
- **Pasting beyond grid bounds** — cells outside the 50×50 grid are silently skipped
- **`localStorage` quota** — size checked before writing, with console warning if too large
- **Corrupted storage** — caught by `try/catch`, bad data is cleared on load
- **Clipboard API permissions denied** — falls back to an internal clipboard for same-tab copy/paste
