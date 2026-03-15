import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50
const STORAGE_KEY = 'spreadsheet_v1'
const SAVE_DEBOUNCE_MS = 500

// ── Helpers ──

function getColumnLabel(col) {
  let label = ''
  let num = col + 1
  while (num > 0) {
    num--
    label = String.fromCharCode(65 + (num % 26)) + label
    num = Math.floor(num / 26)
  }
  return label
}

function loadFromStorage(engine) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    engine.importState(parsed.engine)
    return parsed.styles || {}
  } catch (e) {
    // Corrupted or incompatible data — silently discard
    console.warn('[SpreadsheetApp] Could not restore saved data:', e.message)
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

// ── Main App ──

export default function App() {
  const [engine] = useState(() => {
    const eng = createEngine(TOTAL_ROWS, TOTAL_COLS)
    return eng
  })

  // Cell styles: { "row,col": { bold, italic, underline, bg, color, align, fontSize } }
  const [cellStyles, setCellStyles] = useState({})

  // Version counter to trigger re-renders when engine state changes
  const [version, setVersion] = useState(0)

  // ── Selection Model ──
  // anchor: where the selection started (mouse down or single click)
  // active: the last cell the mouse moved to (or keyboard extended to)
  const [selection, setSelection] = useState(null) // { anchor: {r,c}, active: {r,c} }

  // The cell being actively edited inline
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')

  // ── Sort & Filter State ──
  // sort: { col: number, dir: 'asc' | 'desc' | null }
  const [sort, setSort] = useState({ col: null, dir: null })
  // filters: Map of col index -> Set of allowed values (null = no filter on that col)
  const [filters, setFilters] = useState({}) // { [colIdx]: Set<string> }
  // Which filter dropdown is open
  const [openFilterCol, setOpenFilterCol] = useState(null)

  // ── Copy/Paste Internal Clipboard ──
  // stores the range that was Ctrl+C'd internally
  const internalClipboard = useRef(null)

  const cellInputRef = useRef(null)
  const filterDropdownRef = useRef(null)
  const isMouseSelectingRef = useRef(false)
  const saveTimerRef = useRef(null)

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // ── Bootstrap: Load from localStorage ──
  useEffect(() => {
    const restoredStyles = loadFromStorage(engine)
    if (restoredStyles) {
      setCellStyles(restoredStyles)
      forceRerender()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auto-Save with Debounce ──
  useEffect(() => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      try {
        const data = JSON.stringify({
          engine: engine.exportState(),
          styles: cellStyles
        })
        // Check rough size limit (5MB typical quota)
        if (data.length > 4.5 * 1024 * 1024) {
          console.warn('[SpreadsheetApp] Data too large to save to localStorage.')
          return
        }
        localStorage.setItem(STORAGE_KEY, data)
      } catch (e) {
        console.warn('[SpreadsheetApp] Failed to save to localStorage:', e.message)
      }
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(saveTimerRef.current)
  }, [version, cellStyles, engine])

  // ── Close filter dropdown on outside click ──
  useEffect(() => {
    if (openFilterCol === null) return
    const handler = (e) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target)) {
        setOpenFilterCol(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openFilterCol])

  // ── Cell Style Helpers ──

  const getCellStyle = useCallback((row, col) => {
    return cellStyles[`${row},${col}`] || {
      bold: false, italic: false, underline: false,
      bg: 'white', color: '#202124', align: 'left', fontSize: 13
    }
  }, [cellStyles])

  const updateCellStyle = useCallback((row, col, updates) => {
    setCellStyles(prev => {
      const key = `${row},${col}`
      return { ...prev, [key]: { ...getCellStyle(row, col), ...updates } }
    })
  }, [getCellStyle])

  // ── Selection Derived ──

  const selectionRange = useMemo(() => {
    if (!selection) return null
    const r1 = Math.min(selection.anchor.r, selection.active.r)
    const r2 = Math.max(selection.anchor.r, selection.active.r)
    const c1 = Math.min(selection.anchor.c, selection.active.c)
    const c2 = Math.max(selection.anchor.c, selection.active.c)
    return { r1, r2, c1, c2 }
  }, [selection])

  const isCellInSelection = useCallback((row, col) => {
    if (!selectionRange) return false
    return row >= selectionRange.r1 && row <= selectionRange.r2 &&
           col >= selectionRange.c1 && col <= selectionRange.c2
  }, [selectionRange])

  const isCellAnchor = useCallback((row, col) => {
    return selection?.anchor.r === row && selection?.anchor.c === col
  }, [selection])

  // ── Sort & Filter: View-Layer Row Mapping ──

  const visibleRows = useMemo(() => {
    // Recalculate when engine changes (version) or sort/filters change
    let indices = Array.from({ length: engine.rows }, (_, i) => i)

    // 1. Apply filters (hide rows that don't match)
    for (const [colStr, allowedSet] of Object.entries(filters)) {
      if (!allowedSet || allowedSet.size === 0) continue
      const col = parseInt(colStr)
      indices = indices.filter(r => {
        const cell = engine.getCell(r, col)
        const displayVal = cell.error
          ? cell.error
          : (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
        return allowedSet.has(displayVal)
      })
    }

    // 2. Apply sort (on computed values)
    if (sort.col !== null && sort.dir !== null) {
      const col = sort.col
      indices.sort((a, b) => {
        const cellA = engine.getCell(a, col)
        const cellB = engine.getCell(b, col)
        const valA = cellA.computed !== null && cellA.computed !== '' ? cellA.computed : cellA.raw
        const valB = cellB.computed !== null && cellB.computed !== '' ? cellB.computed : cellB.raw

        // Empty cells always sink to the bottom — same as Excel / Google Sheets
        const emptyA = valA === '' || valA === null || valA === undefined
        const emptyB = valB === '' || valB === null || valB === undefined
        if (emptyA && emptyB) return 0
        if (emptyA) return 1   // a is empty → goes after b
        if (emptyB) return -1  // b is empty → goes after a

        const numA = parseFloat(valA)
        const numB = parseFloat(valB)

        let cmp
        if (!isNaN(numA) && !isNaN(numB)) {
          cmp = numA - numB
        } else {
          cmp = String(valA).localeCompare(String(valB))
        }
        return sort.dir === 'asc' ? cmp : -cmp
      })
    }

    return indices
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, engine, sort, filters])

  // ── Filter Dropdown Data ──

  const getColumnUniqueValues = useCallback((col) => {
    const vals = new Set()
    for (let r = 0; r < engine.rows; r++) {
      const cell = engine.getCell(r, col)
      const displayVal = cell.error
        ? cell.error
        : (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
      vals.add(displayVal)
    }
    return Array.from(vals).sort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, engine])

  const handleSortClick = useCallback((col) => {
    setSort(prev => {
      if (prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      if (prev.dir === 'desc') return { col: null, dir: null }
      return { col, dir: 'asc' }
    })
  }, [])

  const handleFilterToggle = useCallback((col, value) => {
    setFilters(prev => {
      const current = prev[col] ? new Set(prev[col]) : null
      if (!current) {
        // Initialize with all values except the toggled one
        const all = getColumnUniqueValues(col)
        const newSet = new Set(all)
        newSet.delete(value)
        return { ...prev, [col]: newSet }
      }
      const newSet = new Set(current)
      if (newSet.has(value)) {
        newSet.delete(value)
      } else {
        newSet.add(value)
      }
      // If all values selected, clear filter
      const all = getColumnUniqueValues(col)
      if (newSet.size >= all.length) {
        const next = { ...prev }
        delete next[col]
        return next
      }
      return { ...prev, [col]: newSet }
    })
  }, [getColumnUniqueValues])

  const handleFilterSelectAll = useCallback((col) => {
    setFilters(prev => {
      const next = { ...prev }
      delete next[col]
      return next
    })
  }, [])


  const handleClearAllFilters = useCallback(() => {
    setFilters({})
    setSort({ col: null, dir: null })
  }, [])

  // ── Cell Editing ──

  const commitEdit = useCallback((row, col) => {
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  const startEditing = useCallback((row, col) => {
    setSelection({ anchor: { r: row, c: col }, active: { r: row, c: col } })
    setEditingCell({ r: row, c: col })
    setEditValue(engine.getCell(row, col).raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const handleKeyDown = useCallback((event, row, col) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(row, col)
      const nextVisIdx = visibleRows.indexOf(row)
      const nextRow = nextVisIdx < visibleRows.length - 1 ? visibleRows[nextVisIdx + 1] : row
      startEditing(nextRow, col)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    } else if (event.key === 'Escape') {
      setEditValue(engine.getCell(row, col).raw)
      setEditingCell(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      commitEdit(row, col)
      const nextVisIdx = visibleRows.indexOf(row)
      const nextRow = nextVisIdx < visibleRows.length - 1 ? visibleRows[nextVisIdx + 1] : row
      startEditing(nextRow, col)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      commitEdit(row, col)
      const nextVisIdx = visibleRows.indexOf(row)
      const prevRow = nextVisIdx > 0 ? visibleRows[nextVisIdx - 1] : row
      startEditing(prevRow, col)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitEdit(row, col)
      if (col > 0) startEditing(row, col - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    }
  }, [engine, commitEdit, startEditing, visibleRows])

  // ── Global Keyboard Handler ──

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      // Don't intercept when typing in a cell input
      if (editingCell) return

      const isMac = navigator.platform.includes('Mac')
      const ctrl = isMac ? event.metaKey : event.ctrlKey

      if (!selection) return

      // Delete / Backspace: clear selected range
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectionRange) return
        event.preventDefault()
        const ops = []
        for (let r = selectionRange.r1; r <= selectionRange.r2; r++) {
          for (let c = selectionRange.c1; c <= selectionRange.c2; c++) {
            ops.push({ r, c, value: '' })
          }
        }
        engine.batchSetCells(ops)
        forceRerender()
        return
      }

      if (ctrl && event.key === 'z') {
        event.preventDefault()
        if (engine.undo()) forceRerender()
        return
      }

      if (ctrl && (event.key === 'y' || event.key === 'Z')) {
        event.preventDefault()
        if (engine.redo()) forceRerender()
        return
      }

      if (ctrl && event.key === 'c') {
        // Copy computed values from selection
        event.preventDefault()
        if (!selectionRange) return
        const rows_arr = []
        for (let r = selectionRange.r1; r <= selectionRange.r2; r++) {
          const row_vals = []
          for (let c = selectionRange.c1; c <= selectionRange.c2; c++) {
            const cell = engine.getCell(r, c)
            const val = cell.error
              ? cell.error
              : (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
            row_vals.push(val)
          }
          rows_arr.push(row_vals.join('\t'))
        }
        const tsvText = rows_arr.join('\n')
        internalClipboard.current = { r1: selectionRange.r1, c1: selectionRange.c1, text: tsvText }
        navigator.clipboard.writeText(tsvText).catch(() => {})
        return
      }

      if (ctrl && event.key === 'v') {
        event.preventDefault()
        const anchor = selection.anchor
        navigator.clipboard.readText().then(text => {
          if (!text) return
          const lines = text.split('\n').map(l => l.split('\t'))
          const ops = []
          lines.forEach((rowVals, dr) => {
            rowVals.forEach((val, dc) => {
              const r = anchor.r + dr
              const c = anchor.c + dc
              if (r < engine.rows && c < engine.cols) {
                ops.push({ r, c, value: val.trim() })
              }
            })
          })
          engine.batchSetCells(ops)
          forceRerender()
        }).catch(() => {
          // Fallback to internal clipboard
          if (!internalClipboard.current) return
          const { text: t } = internalClipboard.current
          const lines = t.split('\n').map(l => l.split('\t'))
          const ops = []
          lines.forEach((rowVals, dr) => {
            rowVals.forEach((val, dc) => {
              const r = anchor.r + dr
              const c = anchor.c + dc
              if (r < engine.rows && c < engine.cols) {
                ops.push({ r, c, value: val.trim() })
              }
            })
          })
          engine.batchSetCells(ops)
          forceRerender()
        })
        return
      }

      // Arrow navigation without editing
      const anchorR = selection.anchor.r
      const anchorC = selection.anchor.c
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const curVisIdx = visibleRows.indexOf(anchorR)
        const nr = curVisIdx < visibleRows.length - 1 ? visibleRows[curVisIdx + 1] : anchorR
        setSelection({ anchor: { r: nr, c: anchorC }, active: { r: nr, c: anchorC } })
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        const curVisIdx = visibleRows.indexOf(anchorR)
        const nr = curVisIdx > 0 ? visibleRows[curVisIdx - 1] : anchorR
        setSelection({ anchor: { r: nr, c: anchorC }, active: { r: nr, c: anchorC } })
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        const nc = Math.min(anchorC + 1, engine.cols - 1)
        setSelection({ anchor: { r: anchorR, c: nc }, active: { r: anchorR, c: nc } })
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        const nc = Math.max(anchorC - 1, 0)
        setSelection({ anchor: { r: anchorR, c: nc }, active: { r: anchorR, c: nc } })
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [editingCell, selection, selectionRange, engine, forceRerender, visibleRows])

  // ── Mouse Selection ──

  const handleCellMouseDown = useCallback((e, row, col) => {
    e.preventDefault()
    // If clicking same cell that was being edited, do nothing
    if (editingCell && editingCell.r === row && editingCell.c === col) return

    // Commit any open edit
    if (editingCell) commitEdit(editingCell.r, editingCell.c)

    if (e.shiftKey && selection) {
      // Extend selection
      setSelection(prev => ({ ...prev, active: { r: row, c: col } }))
    } else {
      setSelection({ anchor: { r: row, c: col }, active: { r: row, c: col } })
    }
    isMouseSelectingRef.current = true
  }, [editingCell, commitEdit, selection])

  const handleCellMouseEnter = useCallback((row, col) => {
    if (!isMouseSelectingRef.current) return
    setSelection(prev => prev ? { ...prev, active: { r: row, c: col } } : prev)
  }, [])

  const handleCellDoubleClick = useCallback((row, col) => {
    startEditing(row, col)
  }, [startEditing])

  useEffect(() => {
    const handleMouseUp = () => { isMouseSelectingRef.current = false }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // ── Formula Bar ──

  const selectedCell = selection?.anchor
  const selectedCellLabel = selectedCell
    ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}`
    : 'No cell'

  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  const handleFormulaBarChange = (value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }

  const handleFormulaBarKeyDown = (event) => {
    if (!editingCell) return
    handleKeyDown(event, editingCell.r, editingCell.c)
  }

  const handleFormulaBarFocus = () => {
    if (selectedCell && !editingCell) {
      setEditingCell(selectedCell)
      setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
    }
  }

  // ── Formatting Toggles ──

  const selectedCellStyle = selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null

  const toggleBold = () => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { bold: !selectedCellStyle?.bold }) }
  const toggleItalic = () => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { italic: !selectedCellStyle?.italic }) }
  const toggleUnderline = () => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { underline: !selectedCellStyle?.underline }) }
  const changeFontSize = (size) => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { fontSize: size }) }
  const changeAlignment = (align) => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { align }) }
  const changeFontColor = (color) => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { color }) }
  const changeBackgroundColor = (color) => { if (selectedCell) updateCellStyle(selectedCell.r, selectedCell.c, { bg: color }) }

  // ── Row/Col operations ──

  const handleUndo = () => { if (engine.undo()) forceRerender() }
  const handleRedo = () => { if (engine.redo()) forceRerender() }

  const clearSelectedCell = () => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    setCellStyles(prev => { const next = { ...prev }; delete next[`${selectedCell.r},${selectedCell.c}`]; return next })
    setEditValue('')
  }

  const clearAllCells = () => {
    for (let r = 0; r < engine.rows; r++) {
      for (let c = 0; c < engine.cols; c++) engine.setCell(r, c, '')
    }
    forceRerender()
    setCellStyles({})
    setSelection(null)
    setEditingCell(null)
    setEditValue('')
    setSort({ col: null, dir: null })
    setFilters({})
    localStorage.removeItem(STORAGE_KEY)
  }

  const insertRow = () => {
    if (!selectedCell) return
    engine.insertRow(selectedCell.r)
    forceRerender()
    setSelection({ anchor: { r: selectedCell.r + 1, c: selectedCell.c }, active: { r: selectedCell.r + 1, c: selectedCell.c } })
  }

  const deleteRow = () => {
    if (!selectedCell) return
    engine.deleteRow(selectedCell.r)
    forceRerender()
    if (selectedCell.r >= engine.rows) {
      setSelection({ anchor: { r: engine.rows - 1, c: selectedCell.c }, active: { r: engine.rows - 1, c: selectedCell.c } })
    }
  }

  const insertColumn = () => {
    if (!selectedCell) return
    engine.insertColumn(selectedCell.c)
    forceRerender()
    setSelection({ anchor: { r: selectedCell.r, c: selectedCell.c + 1 }, active: { r: selectedCell.r, c: selectedCell.c + 1 } })
  }

  const deleteColumn = () => {
    if (!selectedCell) return
    engine.deleteColumn(selectedCell.c)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelection({ anchor: { r: selectedCell.r, c: engine.cols - 1 }, active: { r: selectedCell.r, c: engine.cols - 1 } })
    }
  }

  // ── Active filter/sort indicators ──
  const hasActiveFiltersOrSort = Object.keys(filters).some(k => filters[k]?.size > 0) || sort.col !== null

  // ── Render ──

  return (
    <div className="app-wrapper" tabIndex={0}>
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
        {hasActiveFiltersOrSort && (
          <button className="toolbar-btn clear-filter-btn" onClick={handleClearAllFilters} title="Clear all sorting and filters">
            ✕ Clear Sort & Filters
          </button>
        )}
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={selectedCellStyle?.color || '#000000'}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBackgroundColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelectedCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAllCells}>✕ All</button>
          </div>
        </div>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => {
                  const colLabel = getColumnLabel(colIndex)
                  const colSort = sort.col === colIndex ? sort.dir : null
                  const colFiltered = filters[colIndex]?.size > 0
                  const uniqueVals = openFilterCol === colIndex ? getColumnUniqueValues(colIndex) : []
                  const allowedSet = filters[colIndex] || null

                  return (
                    <th key={colIndex} className={`col-header ${colFiltered ? 'col-filtered' : ''}`}>
                      <div className="col-header-inner">
                        <span
                          className="col-header-label"
                          onClick={() => handleSortClick(colIndex)}
                          title={`Sort by column ${colLabel}`}
                        >
                          {colLabel}
                          {colSort === 'asc' && <span className="sort-indicator"> ▲</span>}
                          {colSort === 'desc' && <span className="sort-indicator"> ▼</span>}
                        </span>
                        <button
                          className={`filter-btn ${colFiltered ? 'filter-active' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setOpenFilterCol(prev => prev === colIndex ? null : colIndex) }}
                          title={`Filter column ${colLabel}`}
                        >
                          {colFiltered ? '⊟' : '▾'}
                        </button>

                        {openFilterCol === colIndex && (
                          <div className="filter-dropdown" ref={filterDropdownRef}>
                            <div className="filter-dropdown-header">
                              <strong>Filter: {colLabel}</strong>
                              <button className="filter-select-all" onClick={() => handleFilterSelectAll(colIndex)}>Select All</button>
                            </div>
                            <div className="filter-dropdown-list">
                              {uniqueVals.map(val => {
                                const isChecked = !allowedSet || allowedSet.has(val)
                                return (
                                  <label key={val} className="filter-option">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => handleFilterToggle(colIndex, val)}
                                    />
                                    <span>{val === '' ? '(empty)' : val}</span>
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((rowIndex) => (
                <tr key={rowIndex}>
                  <td className={`row-header ${sort.col !== null || Object.keys(filters).some(k => filters[k]?.size > 0) ? 'row-header-sorted' : ''}`}>
                    {rowIndex + 1}
                  </td>
                  {Array.from({ length: engine.cols }, (_, colIndex) => {
                    const isAnchor = isCellAnchor(rowIndex, colIndex)
                    const isInSel = isCellInSelection(rowIndex, colIndex)
                    const isEditing = editingCell?.r === rowIndex && editingCell?.c === colIndex
                    const cellData = engine.getCell(rowIndex, colIndex)
                    const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                    const displayValue = cellData.error
                      ? cellData.error
                      : (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

                    return (
                      <td
                        key={colIndex}
                        className={`cell ${isAnchor ? 'anchor' : ''} ${isInSel ? 'in-selection' : ''}`}
                        style={{ background: style.bg || 'white' }}
                        onMouseDown={(e) => handleCellMouseDown(e, rowIndex, colIndex)}
                        onMouseEnter={() => handleCellMouseEnter(rowIndex, colIndex)}
                        onDoubleClick={() => handleCellDoubleClick(rowIndex, colIndex)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(rowIndex, colIndex)}
                            onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                            ref={isAnchor ? cellInputRef : undefined}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: style.color || '#202124',
                              fontSize: (style.fontSize || 13) + 'px',
                              textAlign: style.align || 'left',
                              background: style.bg || 'white',
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align || 'left'} ${cellData.error ? 'error' : ''}`}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: cellData.error ? '#d93025' : (style.color || '#202124'),
                              fontSize: (style.fontSize || 13) + 'px',
                            }}
                          >
                            {displayValue}
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click to select · Double-click or type to edit · Drag or Shift+Click to select range · Ctrl+C/V to copy/paste · Delete to clear range · Formulas: =SUM(A1:A5) · Click column header to sort · ▾ to filter
        </p>
      </div>
    </div>
  )
}
