import { MathfieldElement } from 'https://unpkg.com/mathlive?module';
import { ComputeEngine, parse, simplify, expand, factor, solve } from 'https://unpkg.com/@cortex-js/compute-engine?module';
import { jsPDF } from 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm';
import { svg2pdf } from 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2/+esm';

const ce = new ComputeEngine();

// Compute Engine can produce syntactically-broken LaTeX for sufficiently nonsensical input
// (e.g. integrating with respect to a matrix "differential") without throwing or flagging it
// as invalid itself - MathLive only reports the problem once asked to parse it (as parse
// errors, not an exception), so this offscreen field exists purely to ask it that question
// before any such result is ever inserted into a real line.
const scratchField = document.createElement('math-field');
scratchField.style.position = 'fixed';
scratchField.style.left = '-9999px';
scratchField.tabIndex = -1;
scratchField.setAttribute('aria-hidden', 'true');
document.body.appendChild(scratchField);

function isWellFormedLatex(latex) {
  scratchField.value = latex;
  return scratchField.errors.length === 0;
}

const themeToggleBtn = document.getElementById('theme-toggle');
const themeToggleLabel = document.getElementById('theme-toggle-label');
const themeToggleIcon = document.getElementById('theme-toggle-icon');
const headerMenuToggle = document.getElementById('header-menu-toggle');
const headerMenuDropdown = document.getElementById('header-menu-dropdown');

// Icon shows the mode a click will switch *to*, matching the adjacent label text.
const SUN_ICON = '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></g>';
const MOON_ICON = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleLabel.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  themeToggleIcon.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  themeToggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
}

// Theme is already applied by the inline script in index.html's <head> (to avoid a flash of
// the wrong theme before this module loads) - just sync the toggle button to match it.
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('mathamorph-theme', next);
  applyTheme(next);
  closeHeaderMenu();
});

function openHeaderMenu() {
  headerMenuDropdown.hidden = false;
  headerMenuToggle.setAttribute('aria-expanded', 'true');
}

function closeHeaderMenu() {
  headerMenuDropdown.hidden = true;
  headerMenuToggle.setAttribute('aria-expanded', 'false');
}

headerMenuToggle.addEventListener('click', () => {
  if (headerMenuDropdown.hidden) openHeaderMenu();
  else closeHeaderMenu();
});

document.addEventListener('click', (ev) => {
  if (!headerMenuDropdown.hidden && !ev.composedPath().includes(headerMenuToggle) && !ev.composedPath().includes(headerMenuDropdown)) {
    closeHeaderMenu();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !headerMenuDropdown.hidden) {
    closeHeaderMenu();
    headerMenuToggle.focus();
  }
});

const documentEl = document.getElementById('document');
const addLineBtn = document.getElementById('btn-add-line');
const exportPdfBtn = document.getElementById('btn-export-pdf');
const saveDocumentBtn = document.getElementById('save-document');
const saveDocumentAsBtn = document.getElementById('save-document-as');
const openDocumentBtn = document.getElementById('open-document');
const openDocumentInput = document.getElementById('open-document-input');
const statusEl = document.getElementById('status');

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', Boolean(isError));
}

// MathLive can typeset a trailing differential as one glued "\mathrm{dx}" token, which
// Compute Engine's parser reads as a two-letter variable rather than d times x - split it back up.
function normalizeDifferentials(latex) {
  return latex.replace(/\\mathrm\{d([a-zA-Z])\}/g, '\\mathrm{d}$1');
}

// The toolbar and selection operations always act on whichever line currently has focus.
let activeMathField = null;

// Opening a field's own menu blurs it, which collapses its selection before the user even
// picks an item - so remember the last real selection seen (e.g. while the menu was computing
// which operations to show) and restore it once the live selection has gone away.
const lastSelectionByField = new WeakMap();

function selectionLatexFor(field) {
  if (!field || field.selectionIsCollapsed) return null;
  const range = field.selection.ranges[0];
  const latex = field.getValue(range, 'latex');
  const normalized = latex && latex.trim() ? normalizeDifferentials(latex) : null;
  if (normalized) lastSelectionByField.set(field, { latex: normalized, range });
  console.log('[debug] selectionLatexFor ->', normalized, 'cacheNow=', lastSelectionByField.get(field));
  return normalized;
}

function getSelectionLatex() {
  if (!activeMathField) return null;
  const live = selectionLatexFor(activeMathField);
  const cached = lastSelectionByField.get(activeMathField)?.latex || null;
  console.log('[debug] getSelectionLatex live=', live, 'cached=', cached, 'collapsed=', activeMathField.selectionIsCollapsed);
  return live || cached || null;
}

// Re-applies the selection range captured before the menu blurred the field, so the upcoming
// replaceSelection() replaces the originally-selected text rather than inserting at the cursor.
function restoreSelectionIfNeeded(field) {
  if (!field || !field.selectionIsCollapsed) return;
  const cached = lastSelectionByField.get(field);
  if (cached) field.selection = { ranges: [cached.range] };
}

function replaceSelection(latex) {
  activeMathField.insert(latex, {
    insertionMode: 'replaceSelection',
    selectionMode: 'item',
    format: 'latex',
  });
}

function allLines() {
  return Array.from(documentEl.querySelectorAll('.doc-line'));
}

function mathFieldIn(lineEl) {
  return lineEl.querySelector('math-field');
}

// Creates one row of the document: a mathfield plus a delete button and a PDF-include checkbox.
function createLine(initialLatex) {
  const line = document.createElement('div');
  line.className = 'doc-line';

  const field = document.createElement('math-field');
  field.value = initialLatex || '';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-line';
  deleteBtn.setAttribute('aria-label', 'Delete line');
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">' +
    '<line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';
  deleteBtn.addEventListener('click', () => removeLine(line));

  const pdfCheckbox = document.createElement('input');
  pdfCheckbox.type = 'checkbox';
  pdfCheckbox.className = 'pdf-include';
  pdfCheckbox.checked = true;
  pdfCheckbox.title = 'Include in PDF export';
  pdfCheckbox.setAttribute('aria-label', 'Include this line in PDF export');
  pdfCheckbox.addEventListener('change', schedulePersist);

  const actions = document.createElement('div');
  actions.className = 'line-actions';
  actions.append(deleteBtn, pdfCheckbox);

  line.append(field, actions);

  field.addEventListener('focus', () => {
    activeMathField = field;
  });
  field.addEventListener('input', schedulePersist);
  // Capture phase, so this runs before MathLive's own internal handler for the same event -
  // stopPropagation() then keeps MathLive's own (now-empty) menu from also trying to open.
  field.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    activeMathField = field;
    field.focus();
    openFieldMenu(field, ev.clientX, ev.clientY);
  }, true);
  // menuItems requires the field to be connected to the DOM, which only happens after
  // the caller appends the returned line - defer until MathLive reports it's mounted.
  field.addEventListener('mount', () => {
    installFieldMenu(field);
    patchMatrixPickerHighlight(field);
    patchContentOverflow(field);
  }, { once: true });
  field.addEventListener('beforeinput', (ev) => {
    if (ev.inputType === 'insertLineBreak') {
      ev.preventDefault();
      insertLineAfter(line);
    }
  });
  field.addEventListener('keydown', (ev) => {
    // MathLive has no default keybinding for the numpad Enter key, so it never reaches
    // beforeinput/insertLineBreak - handle it directly instead.
    if (ev.code === 'NumpadEnter' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      insertLineAfter(line);
      return;
    }
    if (ev.key === 'Backspace' && field.selectionIsCollapsed && field.position === 0) {
      const prev = line.previousElementSibling;
      if (prev) {
        ev.preventDefault();
        mergeIntoPrevious(line, prev);
      }
    }
  });

  return line;
}

function insertLineAfter(line) {
  const newLine = createLine('');
  line.after(newLine);
  mathFieldIn(newLine).focus();
  schedulePersist();
}

// Backspace at the start of a line folds its content onto the end of the line above.
function mergeIntoPrevious(line, prevLine) {
  const field = mathFieldIn(line);
  const prevField = mathFieldIn(prevLine);
  const joinPosition = prevField.lastOffset;
  prevField.value = prevField.value + field.value;
  line.remove();
  prevField.focus();
  prevField.position = joinPosition;
  schedulePersist();
}

function removeLine(line) {
  const lines = allLines();
  if (lines.length <= 1) {
    // Always keep at least one line in the document.
    const field = mathFieldIn(line);
    field.value = '';
    field.focus();
    schedulePersist();
    return;
  }
  const field = mathFieldIn(line);
  const wasActive = activeMathField === field;
  const neighbour = line.previousElementSibling || line.nextElementSibling;
  line.remove();
  if (wasActive && neighbour) mathFieldIn(neighbour).focus();
  schedulePersist();
}

const DOCUMENT_STORAGE_KEY = 'mathamorph-document';

function serializeDocument() {
  return allLines().map((line) => ({
    latex: mathFieldIn(line).value,
    pdfInclude: line.querySelector('.pdf-include').checked,
  }));
}

// Replaces the whole document with the given lines, keeping at least one (empty) line.
function buildDocument(entries) {
  documentEl.innerHTML = '';
  const list = entries && entries.length ? entries : [{ latex: '', pdfInclude: true }];
  for (const entry of list) {
    const line = createLine(entry.latex || '');
    line.querySelector('.pdf-include').checked = entry.pdfInclude !== false;
    documentEl.append(line);
  }
  const firstField = mathFieldIn(documentEl.firstElementChild);
  activeMathField = firstField;
  firstField.focus();
}

// Auto-persists the live document to localStorage, so it survives reloads/browser restarts.
let persistTimeout = null;
function schedulePersist() {
  clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(serializeDocument()));
  }, 400);
}

const FILE_PICKER_TYPES = [{ description: 'Mathamorph document', accept: { 'application/json': ['.json'] } }];

// Remembers the file last opened/saved (when the File System Access API is available), so a
// plain "Save" can write straight back to it instead of always prompting like "Save As".
let currentFileHandle = null;

function applyOpenedDocument(text) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    console.error(err);
    showStatus('That file is not a valid Mathamorph document.', true);
    return;
  }
  buildDocument(entries);
  localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(entries));
  showStatus('Document opened.', false);
}

// Replaces the live document with one loaded from disk, overwriting the auto-persisted copy.
async function openDocument() {
  if (window.showOpenFilePicker) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ types: FILE_PICKER_TYPES });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        showStatus('Could not open that file.', true);
      }
      return;
    }
    const file = await handle.getFile();
    applyOpenedDocument(await file.text());
    currentFileHandle = handle;
    return;
  }
  // Fallback for browsers without the File System Access API: a plain file input can't hand
  // back a reusable handle, so subsequent "Save" clicks behave like "Save As" instead.
  openDocumentInput.click();
}

openDocumentInput.addEventListener('change', () => {
  const file = openDocumentInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => applyOpenedDocument(reader.result);
  reader.onerror = () => showStatus('Could not read that file.', true);
  reader.readAsText(file);
  openDocumentInput.value = '';
});

// Writes straight back to the last opened/saved file if we have a handle for it, otherwise
// falls back to "Save As" since there's nowhere else to write to yet.
async function saveDocument() {
  if (!currentFileHandle) {
    await saveDocumentAs();
    return;
  }
  try {
    const writable = await currentFileHandle.createWritable();
    await writable.write(JSON.stringify(serializeDocument(), null, 2));
    await writable.close();
    showStatus('Document saved.', false);
  } catch (err) {
    console.error(err);
    showStatus('Could not save the document.', true);
  }
}

// Always asks where to save, and remembers the chosen file for subsequent plain saves.
// showSaveFilePicker (Chromium) lets the user pick the filename/location; otherwise falls
// back to a plain anchor download, which always goes to the browser's default downloads folder.
async function saveDocumentAs() {
  const json = JSON.stringify(serializeDocument(), null, 2);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'mathamorph-document.json',
        types: FILE_PICKER_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      currentFileHandle = handle;
      showStatus('Document saved.', false);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        showStatus('Could not save the document.', true);
      }
    }
    return;
  }
  downloadFile('mathamorph-document.json', json, 'application/json');
  showStatus('Document saved.', false);
}

// On startup, restore the last auto-persisted document if there is one, otherwise show a worked example.
function initializeDocument() {
  const raw = localStorage.getItem(DOCUMENT_STORAGE_KEY);
  let entries = null;
  if (raw) {
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      console.error(err);
    }
  }
  buildDocument(entries && entries.length ? entries : [{ latex: 'x^2 + 2x + 1 = 0', pdfInclude: true }]);
}

// Free functions like expand()/factor() can return a boxed expression or, occasionally, null.
// Matrix-shaped results (a List of row Lists) are reformatted as a pmatrix instead of bracket notation.
function resultToLatex(result) {
  if (result === null || result === undefined) return null;
  const json = result.json;
  if (
    Array.isArray(json) &&
    json[0] === 'List' &&
    json.length > 1 &&
    json.slice(1).every((row) => Array.isArray(row) && row[0] === 'List')
  ) {
    const rows = json.slice(1).map((row) => row.slice(1).map((cell) => ce.box(cell).latex).join(' & '));
    return `\\begin{pmatrix}${rows.join(' \\\\ ')}\\end{pmatrix}`;
  }
  if (typeof result.latex === 'string') return result.latex;
  return null;
}

// Compute Engine leaves one of these operations' own name as the result's head when it can't
// resolve it to an actual value (e.g. Inverse of a singular matrix, or a non-square matrix for
// Determinant/Eigenvalues/etc.) - treat that as "no result" rather than inserting it as-is.
const UNRESOLVED_MATRIX_HEADS = new Set([
  'Inverse',
  'Determinant',
  'Transpose',
  'Trace',
  'Rank',
  'Eigenvalues',
  'Eigenvectors',
]);

function isUnresolved(result) {
  if (Array.isArray(result)) return result.some(isUnresolved);
  const json = result && result.json;
  return Array.isArray(json) && UNRESOLVED_MATRIX_HEADS.has(json[0]);
}

function runOperation(compute) {
  showStatus('', false);
  const selectionLatex = getSelectionLatex();
  if (!selectionLatex) {
    showStatus('Select part of the expression first.', true);
    return;
  }

  let result;
  try {
    result = compute(selectionLatex);
  } catch (err) {
    console.error(err);
    showStatus('Could not parse or compute that selection.', true);
    return;
  }

  if (isUnresolved(result)) {
    showStatus(
      'Could not compute a result - check the matrix is square and, for Inverse, that its determinant is not zero.',
      true,
    );
    return;
  }

  if (Array.isArray(result)) result = result.map(resultToLatex).filter(Boolean).join(',\\quad ');
  else result = resultToLatex(result);

  if (!result) {
    showStatus('No result for that selection.', true);
    return;
  }

  if (!isWellFormedLatex(result)) {
    showStatus('Could not produce a valid result for that selection.', true);
    return;
  }

  // The menu blurring the field earlier may have collapsed its selection - restore it so the
  // insert below replaces the originally-selected text instead of landing at a stale cursor.
  restoreSelectionIfNeeded(activeMathField);
  replaceSelection(result);
  activeMathField.focus();
}

// Which symbols in a selection are actual free variables (as opposed to known constants like
// pi, or function names like f in f(x)) - Compute Engine's own `unknowns` already filters those
// out correctly, so operations needing a variable (Differentiate/Integrate/Solve) can offer it
// automatically instead of requiring it to be typed into a separate box every time.
function freeVariablesOf(latex) {
  try {
    return [...ce.parse(latex).unknowns].sort();
  } catch {
    return [];
  }
}

// The variable to pre-fill when more than one is found (e.g. for the Series dialog) - "x" is
// overwhelmingly the most common choice, so prefer it over just taking the alphabetically first.
function bestGuessVariable(unknowns) {
  if (unknowns.includes('x')) return 'x';
  return unknowns[0] || 'x';
}

// If the selection is already a complete D(...) or Integrate(...) expression, wrapping it again
// would differentiate/integrate it a second time instead of evaluating what's there.
function isHeaded(latex, head) {
  const json = ce.parse(latex).json;
  return Array.isArray(json) && json[0] === head;
}

// Compute Engine's handling of equations is inconsistent between free functions - expand()
// recurses into both sides of an Equal relation, but simplify()/factor()/etc. do not, leaving
// the equation untouched. Apply algebra operations to each side independently so the result is
// always consistent regardless of which operation was picked.
function applyPerSide(latex, computeFn) {
  const json = ce.parse(latex).json;
  if (Array.isArray(json) && json[0] === 'Equal') {
    const lhsResult = computeFn(ce.box(json[1]).latex);
    const rhsResult = computeFn(ce.box(json[2]).latex);
    return ce.box(['Equal', lhsResult, rhsResult]);
  }
  return computeFn(latex);
}

// Shared by the toolbar buttons and each mathfield's own "Morph" context menu, so both stay in sync.
const operations = [
  {
    id: 'simplify',
    label: 'Simplify',
    group: 'algebra',
    description: 'Rewrite as a simpler equivalent expression, keeping exact values and symbolic constants (e.g. \u03c0) as-is.',
    compute: (latex) => applyPerSide(latex, (l) => simplify(l)),
  },
  {
    id: 'expand',
    label: 'Expand',
    group: 'algebra',
    description: 'Multiply out brackets and combine like terms.',
    compute: (latex) => applyPerSide(latex, (l) => expand(l)),
  },
  {
    id: 'factor',
    label: 'Factor',
    group: 'algebra',
    description: 'Rewrite as a product of factors.',
    compute: (latex) => applyPerSide(latex, (l) => factor(l)),
  },
  {
    id: 'evaluate',
    label: 'Evaluate',
    group: 'algebra',
    description: 'Compute a numeric (decimal) approximation, including for irrational constants.',
    compute: (latex) => applyPerSide(latex, (l) => parse(l).N()),
  },
  {
    id: 'partial-fractions',
    label: 'Partial fractions',
    group: 'algebra',
    description: 'Split a rational expression into a sum of simpler fractions.',
    compute: (latex) => applyPerSide(latex, (l) => ce.box(['PartialFraction', ce.parse(l)]).evaluate()),
  },
  {
    id: 'diff',
    label: 'Differentiate',
    group: 'calculus',
    needsVariable: true,
    description: 'Differentiate with respect to the detected variable (or your choice, if there is more than one).',
    compute: (latex, variable) => {
      if (isHeaded(latex, 'D')) return ce.parse(latex).evaluate();
      return parse(`\\frac{d}{d${variable}}\\left(${latex}\\right)`).evaluate();
    },
  },
  {
    id: 'integrate',
    label: 'Integrate',
    group: 'calculus',
    needsVariable: true,
    description: 'Integrate with respect to the detected variable (or your choice, if there is more than one).',
    compute: (latex, variable) => {
      if (isHeaded(latex, 'Integrate')) return ce.parse(latex).evaluate();
      return parse(`\\int\\left(${latex}\\right)\\,d${variable}`).evaluate();
    },
  },
  {
    id: 'series',
    label: 'Series',
    group: 'calculus',
    description: 'Expand as a Taylor series - opens a dialog to choose the variable, expansion point and order.',
    compute: (latex, variable, about, order) =>
      ce.parse(`\\operatorname{Series}(${latex}, ${variable}, ${about}, ${order})`).evaluate(),
  },
  {
    id: 'solve',
    label: 'Solve',
    group: 'solve',
    needsVariable: true,
    description: 'Find the value(s) of the detected variable (or your choice, if there is more than one) that satisfy the equation.',
    compute: (latex, variable) => solve(latex, variable),
  },
  {
    id: 'inverse',
    label: 'Inverse',
    group: 'matrix',
    description: 'Compute the inverse of a square matrix.',
    compute: (latex) => ce.box(['Inverse', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'determinant',
    label: 'Determinant',
    group: 'matrix',
    description: 'Compute the determinant of a square matrix.',
    compute: (latex) => ce.box(['Determinant', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'transpose',
    label: 'Transpose',
    group: 'matrix',
    description: 'Swap the rows and columns of a matrix.',
    compute: (latex) => ce.box(['Transpose', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'trace',
    label: 'Trace',
    group: 'matrix',
    description: 'Sum of the elements on the main diagonal of a square matrix.',
    compute: (latex) => ce.box(['Trace', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'rank',
    label: 'Rank',
    group: 'matrix',
    description: 'Number of linearly independent rows (or columns) of a matrix.',
    compute: (latex) => ce.box(['Rank', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'eigenvalues',
    label: 'Eigenvalues',
    group: 'matrix',
    description: 'Compute the eigenvalues of a square matrix.',
    compute: (latex) => ce.box(['Eigenvalues', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'eigenvectors',
    label: 'Eigenvectors',
    group: 'matrix',
    description: 'Compute the eigenvectors of a square matrix.',
    compute: (latex) => ce.box(['Eigenvectors', ce.parse(latex)]).evaluate(),
  },
];

// Rather than guessing which operations suit the current selection (unreliable, and fiddly to
// get right for every edge case), the "Morph" menu always offers everything, organised into
// these three fixed submenus - running an operation on something it doesn't apply to is harmless,
// since compute() below just leaves the selection unchanged.
const MORPH_CATEGORIES = [
  { label: 'Algebra', groups: ['algebra', 'solve'] },
  { label: 'Calculus', groups: ['calculus'] },
  { label: 'Matrices', groups: ['matrix'] },
];

// Simplify, Evaluate and Solve are generic enough, and reached for often enough, to be worth a
// single click rather than making every use wait through an "Algebra" submenu - every other
// operation is specific enough to a particular kind of selection that the extra click costs
// little. These are shown above the submenus, and excluded from them to avoid duplication.
const MORPH_TOP_LEVEL_IDS = ['simplify', 'evaluate', 'solve'];

// A single shared context menu for "Morph" operations, triggered by right-clicking a selection.
// MathLive's own menu system has a long-standing upstream bug where nested-submenu clicks get
// swallowed (https://github.com/arnog/mathlive/issues/2927), which made "Morph" unreliable when
// it lived inside that menu - this plain DOM dropdown sidesteps the problem entirely. It now
// also fully replaces MathLive's own field menu (Cut/Copy/Paste/Insert Matrix/Mode), reusing
// MathLive's own command logic (via the cached native items below) but with our own reliable
// click handling.
const fieldMenu = document.createElement('ul');
fieldMenu.className = 'morph-menu';
fieldMenu.setAttribute('role', 'menu');
fieldMenu.hidden = true;
// Mousedown on a button normally shifts focus to it, which blurs the field and visibly collapses
// its selection highlight - even though the selection is still applied correctly behind the
// scenes (see lastSelectionByField/restoreSelectionIfNeeded below), seeing it vanish is confusing,
// especially while clicking through a submenu to reach an operation. Preventing the mousedown's
// default action keeps focus (and the highlight) on the field for the whole menu interaction,
// without affecting the click events the menu's buttons rely on.
fieldMenu.addEventListener('mousedown', (ev) => ev.preventDefault());
document.body.appendChild(fieldMenu);

function closeFieldMenu() {
  fieldMenu.hidden = true;
}

// Some of MathLive's own menu item labels are lazy getter functions (for localisation)
// rather than plain strings - resolve either form to display text.
function resolveLabel(item) {
  return typeof item?.label === 'function' ? item.label() : item?.label;
}

function addMenuDivider(menu) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  li.className = 'morph-menu-divider';
  menu.appendChild(li);
}

function addMenuButton(menu, label, onActivate, title) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'morph-menu-item';
  button.setAttribute('role', 'menuitem');
  if (title) button.title = title;
  button.textContent = label;
  button.addEventListener('click', () => {
    onActivate();
    closeFieldMenu();
  });
  li.appendChild(button);
  menu.appendChild(li);
  return li;
}

// An inline, click-to-expand submenu (rather than MathLive's hover-to-open flyouts, which is
// exactly the interaction pattern its own nested menus get stuck on) - items: {label, onActivate},
// optionally {html: true} to render a raw HTML label (for the math template previews reused from
// MathLive's own "Insert" menu) instead of plain text, {heading: 'Section title'} for a
// non-interactive section label splitting up a long list of items (also borrowed from there), or
// {submenu: [...]} to nest another expandable level (e.g. Differentiate/Integrate/Solve, when a
// selection has more than one candidate variable to pick from) - title sets a tooltip on this
// submenu's own toggle button.
function addSubmenu(menu, label, items, title) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'morph-menu-item morph-submenu-toggle';
  toggle.setAttribute('role', 'menuitem');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  if (title) toggle.title = title;
  toggle.textContent = label;

  const submenu = document.createElement('ul');
  submenu.className = 'morph-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.hidden = true;
  // Reserve space for a tick mark on every item if any item in this submenu uses one, so
  // unchecked items don't shift when a different one becomes checked.
  if (items.some((item) => 'checked' in item)) submenu.classList.add('morph-submenu-checkable');

  for (const item of items) {
    const subLi = document.createElement('li');
    subLi.setAttribute('role', 'none');

    if (item.heading) {
      subLi.className = 'morph-submenu-heading';
      subLi.textContent = item.heading;
      submenu.appendChild(subLi);
      continue;
    }

    if (item.submenu) {
      addSubmenu(submenu, item.label, item.submenu, item.description);
      continue;
    }

    const subButton = document.createElement('button');
    subButton.type = 'button';
    subButton.className = 'morph-menu-item';
    subButton.classList.toggle('morph-menu-item-checked', Boolean(item.checked));
    subButton.setAttribute('role', 'checked' in item ? 'menuitemradio' : 'menuitem');
    if ('checked' in item) subButton.setAttribute('aria-checked', String(Boolean(item.checked)));
    if (item.description) subButton.title = item.description;
    if (item.html) subButton.innerHTML = item.label;
    else subButton.textContent = item.label;
    subButton.addEventListener('click', () => {
      item.onActivate();
      closeFieldMenu();
    });
    subLi.appendChild(subButton);
    submenu.appendChild(subLi);
  }

  toggle.addEventListener('click', () => {
    const willOpen = submenu.hidden;
    // Only one submenu should be open at a time - collapse any other open submenu in this
    // same menu before (or instead of) opening this one.
    for (const otherToggle of menu.querySelectorAll(':scope > li > .morph-submenu-toggle')) {
      if (otherToggle === toggle) continue;
      otherToggle.setAttribute('aria-expanded', 'false');
      otherToggle.nextElementSibling.hidden = true;
    }
    submenu.hidden = !willOpen;
    toggle.setAttribute('aria-expanded', String(willOpen));
  });

  li.append(toggle, submenu);
  menu.appendChild(li);
  return li;
}

// A 5x5 grid of cells (matching MathLive's own insert-matrix size range) that highlights up to
// the hovered cell and, on click, runs the matching native insert-matrix-RxC command.
function addMatrixPicker(menu, field, insertMatrixItems) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const label = document.createElement('div');
  label.className = 'matrix-picker-label';
  label.textContent = 'Insert matrix';
  const grid = document.createElement('div');
  grid.className = 'matrix-picker-grid';
  const cells = [];
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 5; col++) {
      const cell = document.createElement('div');
      cell.className = 'matrix-picker-cell';
      cell.addEventListener('mouseenter', () => {
        label.textContent = `Insert matrix (${row} \u00d7 ${col})`;
        for (const c of cells) c.cell.classList.toggle('active', c.row <= row && c.col <= col);
      });
      cell.addEventListener('click', () => {
        const item = insertMatrixItems.find((i) => i.data.row === row && i.data.col === col);
        activeMathField = field;
        field.focus();
        item?.onMenuSelect();
        closeFieldMenu();
      });
      cells.push({ cell, row, col });
      grid.appendChild(cell);
    }
  }
  grid.addEventListener('mouseleave', () => {
    label.textContent = 'Insert matrix';
    for (const c of cells) c.cell.classList.remove('active');
  });
  li.append(label, grid);
  menu.appendChild(li);
}

// Series needs three pieces of information (variable, expansion point, truncation order) rather
// than the single variable Differentiate/Integrate/Solve need, so a quick variable-picker
// submenu doesn't fit it as well - it always opens this small dialog instead, pre-filled with
// sensible defaults (the detected variable, about 0, order 4) that can be overridden.
const seriesDialog = document.createElement('dialog');
seriesDialog.className = 'series-dialog';
seriesDialog.innerHTML = `
  <form method="dialog">
    <h2>Series</h2>
    <div class="series-dialog-field">
      <label for="series-dialog-variable">Variable</label>
      <input id="series-dialog-variable" type="text" />
    </div>
    <div class="series-dialog-field">
      <label for="series-dialog-about">About</label>
      <input id="series-dialog-about" type="text" />
    </div>
    <div class="series-dialog-field">
      <label for="series-dialog-order" title="The highest power of the variable to expand up to - not a count of terms, since some powers may not appear (e.g. a series with only odd powers).">Order</label>
      <input id="series-dialog-order" type="text" />
    </div>
    <div class="series-dialog-actions">
      <button type="button" class="series-dialog-cancel">Cancel</button>
      <button type="submit" value="compute" class="series-dialog-compute">Compute</button>
    </div>
  </form>
`;
document.body.appendChild(seriesDialog);
const seriesVariableInput = seriesDialog.querySelector('#series-dialog-variable');
const seriesAboutDialogInput = seriesDialog.querySelector('#series-dialog-about');
const seriesOrderDialogInput = seriesDialog.querySelector('#series-dialog-order');
seriesDialog.querySelector('.series-dialog-cancel').addEventListener('click', () => seriesDialog.close('cancel'));

let seriesDialogField = null;
seriesDialog.addEventListener('close', () => {
  if (seriesDialog.returnValue !== 'compute') return;
  const variable = seriesVariableInput.value.trim() || 'x';
  const about = seriesAboutDialogInput.value.trim() || '0';
  const order = seriesOrderDialogInput.value.trim() || '4';
  activeMathField = seriesDialogField;
  runOperation((latex) => ce.parse(`\\operatorname{Series}(${latex}, ${variable}, ${about}, ${order})`).evaluate());
});

function openSeriesDialog(field, unknowns) {
  seriesDialogField = field;
  // Reset so a dialog dismissed with Escape (which skips the Cancel button, and so never sets
  // returnValue) doesn't carry over a stale 'compute' from a previous use of this same dialog.
  seriesDialog.returnValue = '';
  seriesVariableInput.value = bestGuessVariable(unknowns);
  seriesAboutDialogInput.value = '0';
  seriesOrderDialogInput.value = '4';
  seriesDialog.showModal();
  seriesVariableInput.focus();
  seriesVariableInput.select();
}

// Builds the {label, description, onActivate} (or {..., submenu}) descriptor for one operation's
// menu entry, given the free variables detected in the current selection - Series always opens
// its own dialog regardless; Differentiate/Integrate/Solve run immediately against the only (or
// best-guess) variable, or expand into a variable-picking submenu if the selection has several.
function buildOperationMenuItem(op, unknowns, field) {
  if (op.id === 'series') {
    return {
      label: op.label,
      description: op.description,
      onActivate: () => openSeriesDialog(field, unknowns),
    };
  }

  if (op.needsVariable) {
    if (unknowns.length > 1) {
      return {
        label: op.label,
        description: op.description,
        submenu: unknowns.map((variable) => ({
          label: variable,
          onActivate: () => {
            activeMathField = field;
            runOperation((latex) => op.compute(latex, variable));
          },
        })),
      };
    }
    const variable = unknowns[0] || 'x';
    return {
      label: op.label,
      description: op.description,
      onActivate: () => {
        activeMathField = field;
        runOperation((latex) => op.compute(latex, variable));
      },
    };
  }

  return {
    label: op.label,
    description: op.description,
    onActivate: () => {
      activeMathField = field;
      runOperation(op.compute);
    },
  };
}

// Renders a {label, onActivate} or {label, submenu} descriptor from buildOperationMenuItem()
// directly into a menu - shared by the top-level items and each category submenu's items.
function renderMenuItem(menu, item) {
  if (item.submenu) addSubmenu(menu, item.label, item.submenu, item.description);
  else addMenuButton(menu, item.label, item.onActivate, item.description);
}

// Builds and shows the field's whole right-click menu: Morph operations for the current
// selection (if any), clipboard actions, export, and the always-available insert/mode tools.
function openFieldMenu(field, x, y) {
  const native = nativeMenuDataByField.get(field);
  const selectionLatex = selectionLatexFor(field);

  fieldMenu.innerHTML = '';

  if (selectionLatex) {
    const unknowns = freeVariablesOf(selectionLatex);

    const topLevelOps = operations.filter((op) => MORPH_TOP_LEVEL_IDS.includes(op.id));
    for (const op of topLevelOps) {
      renderMenuItem(fieldMenu, buildOperationMenuItem(op, unknowns, field));
    }
    if (topLevelOps.length) addMenuDivider(fieldMenu);

    for (const category of MORPH_CATEGORIES) {
      const items = operations.filter((op) => category.groups.includes(op.group) && !MORPH_TOP_LEVEL_IDS.includes(op.id));
      addSubmenu(
        fieldMenu,
        category.label,
        items.map((op) => buildOperationMenuItem(op, unknowns, field)),
      );
    }
    addMenuDivider(fieldMenu);

    addMenuButton(fieldMenu, 'Cut', () => native.cut?.onMenuSelect());
    addMenuButton(fieldMenu, 'Copy', () => field.executeCommand('copyToClipboard'));
    addSubmenu(
      fieldMenu,
      'Copy special',
      native.copyFormats.map((format) => ({ label: resolveLabel(format), onActivate: () => format.onMenuSelect() })),
    );
    addMenuDivider(fieldMenu);
  }

  const exportItem = buildExportMenu(field);
  for (const exp of exportItem.submenu) addMenuButton(fieldMenu, exp.label, () => exp.onMenuSelect());
  addMenuDivider(fieldMenu);

  addMenuButton(fieldMenu, 'Paste', () => native.paste?.onMenuSelect());
  addMenuDivider(fieldMenu);

  addMatrixPicker(fieldMenu, field, native.insertMatrix);
  addMenuDivider(fieldMenu);

  addSubmenu(
    fieldMenu,
    'Insert',
    native.insertTemplates.map((item) =>
      item.type === 'heading'
        ? { heading: resolveLabel(item) }
        : { label: resolveLabel(item), html: true, onActivate: () => item.onMenuSelect() },
    ),
  );
  addMenuDivider(fieldMenu);

  addSubmenu(
    fieldMenu,
    'Mode',
    native.modes.map((mode) => ({
      label: resolveLabel(mode),
      checked: typeof mode.checked === 'function' ? mode.checked() : Boolean(mode.checked),
      onActivate: () => mode.onMenuSelect(),
    })),
  );

  fieldMenu.hidden = false;
  // Clamp position so the menu doesn't spill off the right/bottom edge of the viewport.
  const rect = fieldMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  fieldMenu.style.left = `${left}px`;
  fieldMenu.style.top = `${top}px`;
}

// Capture phase, since clicks inside the math-field's own shadow DOM get stopped there before
// they'd otherwise bubble up to document - capture fires first, so this still sees them.
document.addEventListener('click', (ev) => {
  if (!fieldMenu.hidden && !fieldMenu.contains(ev.target)) closeFieldMenu();
}, true);

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !fieldMenu.hidden) closeFieldMenu();
});

// Caches the handful of MathLive native menu items whose logic we reuse (Cut/Copy
// formats/Paste/Insert Matrix/Insert templates/Mode) before replacing the field's own menu with
// an empty one.
const nativeMenuDataByField = new WeakMap();

function installFieldMenu(field) {
  const defaultItems = field.menuItems;
  const findItem = (id) => defaultItems.find((item) => item.id === id);
  nativeMenuDataByField.set(field, {
    cut: findItem('cut'),
    copyFormats: findItem('copy')?.submenu ?? [],
    paste: findItem('paste'),
    insertMatrix: findItem('insert-matrix')?.submenu ?? [],
    insertTemplates: findItem('insert')?.submenu ?? [],
    modes: findItem('mode')?.submenu ?? [],
  });
  // MathLive's own menu system has a long-standing upstream bug where nested-submenu clicks
  // get swallowed (https://github.com/arnog/mathlive/issues/2927) - replace it entirely with
  // our own right-click menu (see openFieldMenu), which reuses this cached command logic.
  field.menuItems = [];
}

// MathJax's SVG output renders every glyph as real <path> vector data (no fonts/foreignObject
// to embed), so exports stay crisp at any zoom and can be embedded as genuine vector paths in
// a PDF via svg2pdf.js - unlike MathLive's own rendering, which is just painted pixels by the
// time anything outside the page tries to capture it.
let mathJaxReadyPromise = null;
function loadMathJax() {
  if (!mathJaxReadyPromise) {
    mathJaxReadyPromise = new Promise((resolve, reject) => {
      // fontCache 'local' bakes each glyph's path data into every SVG, so each one is fully
      // self-contained rather than relying on a shared global cache.
      window.MathJax = { svg: { fontCache: 'local' }, startup: { typeset: false } };
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
      script.onload = () => window.MathJax.startup.promise.then(resolve, reject);
      script.onerror = () => reject(new Error('Could not load MathJax.'));
      document.head.appendChild(script);
    });
  }
  return mathJaxReadyPromise;
}

// Renders LaTeX to a standalone SVG element - sized in real pixels (via the em/ex conversion
// options) rather than the "ex" units MathJax uses by default, which only make sense in the
// context of surrounding text that won't exist once this is exported elsewhere.
async function latexToSvg(latex, em = 18) {
  await loadMathJax();
  const ex = em / 2;
  const container = await window.MathJax.tex2svgPromise(latex, { display: true, em, ex });
  const svg = container.querySelector('svg');

  svg.removeAttribute('role');
  svg.removeAttribute('focusable');
  svg.removeAttribute('aria-hidden');
  const g = svg.querySelector('g');
  if (g) {
    // A pure fill renders too faint at small sizes in some PDF viewers (generic vector paths
    // don't get the hinting/stem-darkening treatment real embedded PDF text gets), but the
    // default stroke width (previously just "stroke: black" with no explicit width) rendered
    // too heavy once zoomed out to see the whole page. This is a deliberately small, explicit
    // compromise - thin enough to stay crisp zoomed in, present enough to stay visible zoomed out.
    g.setAttribute('fill', 'black');
    g.setAttribute('stroke', 'black');
    g.setAttribute('stroke-width', '30');
  }

  const width = parseFloat(svg.getAttribute('width')) * ex;
  const height = parseFloat(svg.getAttribute('height')) * ex;
  svg.setAttribute('width', `${width}px`);
  svg.setAttribute('height', `${height}px`);

  return { svg, width, height };
}

function serializeSvg(svg) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + new XMLSerializer().serializeToString(svg);
}

async function latexToCanvas(latex, em = 18, scale = 3) {
  const { svg, width, height } = await latexToSvg(latex, em);
  const img = new Image();
  const loaded = new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Could not rasterize the formula.'));
  });
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serializeSvg(svg));
  await loaded;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

  return { canvas, width, height };
}

async function latexToPngBlob(latex, em = 18, scale = 3) {
  const { canvas } = await latexToCanvas(latex, em, scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
  });
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildExportMenu(field) {
  const latexForExport = () => selectionLatexFor(field) || field.value;

  return {
    label: 'Export',
    submenu: [
      {
        label: 'Copy as PNG',
        onMenuSelect: async () => {
          const latex = latexForExport();
          if (!latex || !latex.trim()) {
            showStatus('Nothing to export.', true);
            return;
          }
          try {
            const blob = await latexToPngBlob(latex);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showStatus('Copied as an image.', false);
          } catch (err) {
            console.error(err);
            showStatus('Could not copy as an image.', true);
          }
        },
      },
      {
        label: 'Download as SVG',
        onMenuSelect: async () => {
          const latex = latexForExport();
          if (!latex || !latex.trim()) {
            showStatus('Nothing to export.', true);
            return;
          }
          try {
            const { svg } = await latexToSvg(latex);
            downloadFile('mathamorph.svg', serializeSvg(svg), 'image/svg+xml');
            showStatus('Downloaded as SVG.', false);
          } catch (err) {
            console.error(err);
            showStatus('Could not export as SVG.', true);
          }
        },
      },
    ],
  };
}

// The Insert Matrix size-picker grid highlights its drag-preview cells via an internal
// 'active' class, which ::part() selectors in an external stylesheet can't reach -
// inject a rule directly into the field's shadow root instead.
function patchMatrixPickerHighlight(field) {
  const style = document.createElement('style');
  style.textContent = `
    [part='menu-item'].active {
      background: var(--field-border-focus) !important;
      color: #ffffff !important;
    }
  `;
  field.shadowRoot.appendChild(style);
}

// MathLive clips an overly wide formula (e.g. (a+b)^89 fully expanded) rather than wrapping or
// scrolling it, silently hiding most of the result - force its internal content to scroll
// horizontally instead, since that can only be reached via the shadow root, not ::part().
function patchContentOverflow(field) {
  const style = document.createElement('style');
  style.textContent = `
    .ML__content {
      overflow-x: auto !important;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
    }
    .ML__content::-webkit-scrollbar {
      height: 8px;
    }
    .ML__content::-webkit-scrollbar-track {
      background: transparent;
    }
    .ML__content::-webkit-scrollbar-thumb {
      background: var(--border-strong);
      border-radius: 4px;
    }
    .ML__content::-webkit-scrollbar-thumb:hover {
      background: var(--field-border-focus);
    }
  `;
  field.shadowRoot.appendChild(style);
}

addLineBtn.addEventListener('click', () => {
  const lines = allLines();
  insertLineAfter(lines[lines.length - 1]);
});

// Renders each checked line's equation to a canvas (reusing the same pipeline as "Copy as
// PNG") and stacks them top-to-bottom into an A4 PDF, paginating as each page fills up.
async function exportPdf() {
  const lines = allLines().filter((line) => line.querySelector('.pdf-include').checked);
  const withContent = lines.filter((line) => mathFieldIn(line).value.trim());
  if (withContent.length === 0) {
    showStatus('No lines selected for PDF export.', true);
    return;
  }

  exportPdfBtn.disabled = true;
  showStatus('Building PDF...', false);
  try {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const maxWidth = pageWidth - margin * 2;
    const lineGap = 18;
    const pxToPt = 72 / 96;
    // Shrinking purely to fit the page width can crush a genuinely extreme, very wide line
    // (e.g. (a+b)^89 fully expanded) down to a fraction of a point tall and effectively
    // invisible. Never shrink a line below this fraction of its natural size, accepting that
    // such lines will instead overflow the page's right-hand margin - this only ever kicks in
    // for pathologically wide content; ordinary long equations shrink-to-fit as before.
    const minScale = 0.2;
    let anyLineOverflowed = false;
    let y = margin;

    for (const line of withContent) {
      const { svg, width, height } = await latexToSvg(mathFieldIn(line).value);
      // svg2pdf needs the element connected to the document to measure/render it correctly.
      document.body.appendChild(svg);

      let pdfWidth = width * pxToPt;
      let pdfHeight = height * pxToPt;
      if (pdfWidth > maxWidth) {
        const widthRatio = maxWidth / pdfWidth;
        const ratio = Math.max(widthRatio, minScale);
        if (ratio > widthRatio) anyLineOverflowed = true;
        pdfWidth *= ratio;
        pdfHeight *= ratio;
      }
      if (y + pdfHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      await svg2pdf(svg, doc, { x: margin, y, width: pdfWidth, height: pdfHeight });
      svg.remove();
      y += pdfHeight + lineGap;
    }

    doc.save('mathamorph.pdf');
    const overflowNote = anyLineOverflowed ? ' Some lines were too wide to fit the page and overflow its edge.' : '';
    showStatus(`Exported ${withContent.length} line(s) to PDF.${overflowNote}`, false);
  } catch (err) {
    console.error(err);
    showStatus('Could not export PDF.', true);
  } finally {
    exportPdfBtn.disabled = false;
  }
}

exportPdfBtn.addEventListener('click', exportPdf);

openDocumentBtn.addEventListener('click', () => {
  openDocument();
  closeHeaderMenu();
});

saveDocumentBtn.addEventListener('click', () => {
  saveDocument();
  closeHeaderMenu();
});

saveDocumentAsBtn.addEventListener('click', () => {
  saveDocumentAs();
  closeHeaderMenu();
});

initializeDocument();
