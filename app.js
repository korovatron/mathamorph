import { MathfieldElement } from 'https://unpkg.com/mathlive?module';
import { ComputeEngine, parse, simplify, expand, factor, solve } from 'https://unpkg.com/@cortex-js/compute-engine?module';

const ce = new ComputeEngine();

const themeToggleBtn = document.getElementById('theme-toggle');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  themeToggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
}

// Theme is already applied by the inline script in index.html's <head> (to avoid a flash of
// the wrong theme before this module loads) - just sync the toggle button to match it.
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('mathamorph-theme', next);
  applyTheme(next);
});

const documentEl = document.getElementById('document');
const addLineBtn = document.getElementById('btn-add-line');
const variableInput = document.getElementById('variable-input');
const seriesAboutInput = document.getElementById('series-about');
const seriesTermsInput = document.getElementById('series-terms');
const statusEl = document.getElementById('status');

// Which operations are useful depends on what kind of thing is selected, not just whether
// anything is - used to filter each field's "Morph" submenu to only the relevant operations.
function classifySelection(latex) {
  if (!latex) return 'none';
  try {
    const head = ce.parse(latex).json[0];
    if (head === 'Matrix') return 'matrix';
    if (head === 'Equal') return 'equation';
  } catch {
    // Fall through: still classify as a plain expression so the menu shows something.
  }
  return 'expression';
}

const visibleGroupsByKind = {
  none: [],
  expression: ['algebra', 'calculus'],
  equation: ['algebra', 'solve'],
  matrix: ['matrix'],
};

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

function selectionLatexFor(field) {
  if (!field || field.selectionIsCollapsed) return null;
  const range = field.selection.ranges[0];
  const latex = field.getValue(range, 'latex');
  return latex && latex.trim() ? normalizeDifferentials(latex) : null;
}

function getSelectionLatex() {
  return selectionLatexFor(activeMathField);
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

// Creates one row of the document: a mathfield plus a button to delete that row.
function createLine(initialLatex) {
  const line = document.createElement('div');
  line.className = 'doc-line';

  const field = document.createElement('math-field');
  field.value = initialLatex || '';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-line';
  deleteBtn.setAttribute('aria-label', 'Delete line');
  deleteBtn.textContent = '\u00d7';
  deleteBtn.addEventListener('click', () => removeLine(line));

  line.append(field, deleteBtn);

  field.addEventListener('focus', () => {
    activeMathField = field;
  });
  // menuItems requires the field to be connected to the DOM, which only happens after
  // the caller appends the returned line - defer until MathLive reports it's mounted.
  field.addEventListener('mount', () => {
    installFieldMenu(field);
    patchMatrixPickerHighlight(field);
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
}

function removeLine(line) {
  const lines = allLines();
  if (lines.length <= 1) {
    // Always keep at least one line in the document.
    const field = mathFieldIn(line);
    field.value = '';
    field.focus();
    return;
  }
  const field = mathFieldIn(line);
  const wasActive = activeMathField === field;
  const neighbour = line.previousElementSibling || line.nextElementSibling;
  line.remove();
  if (wasActive && neighbour) mathFieldIn(neighbour).focus();
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

  if (Array.isArray(result)) result = result.map(resultToLatex).filter(Boolean).join(',\\quad ');
  else result = resultToLatex(result);

  if (!result) {
    showStatus('No result for that selection.', true);
    return;
  }

  replaceSelection(result);
  activeMathField.focus();
}

function currentVariable() {
  return variableInput.value.trim() || 'x';
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
  { id: 'simplify', label: 'Simplify', group: 'algebra', compute: (latex) => applyPerSide(latex, (l) => simplify(l)) },
  { id: 'expand', label: 'Expand', group: 'algebra', compute: (latex) => applyPerSide(latex, (l) => expand(l)) },
  { id: 'factor', label: 'Factor', group: 'algebra', compute: (latex) => applyPerSide(latex, (l) => factor(l)) },
  { id: 'evaluate', label: 'Evaluate', group: 'algebra', compute: (latex) => applyPerSide(latex, (l) => parse(l).N()) },
  {
    id: 'partial-fractions',
    label: 'Partial fractions',
    group: 'algebra',
    compute: (latex) => applyPerSide(latex, (l) => ce.box(['PartialFraction', ce.parse(l)]).evaluate()),
  },
  {
    id: 'diff',
    label: 'Differentiate',
    group: 'calculus',
    compute: (latex) => {
      if (isHeaded(latex, 'D')) return ce.parse(latex).evaluate();
      const v = currentVariable();
      return parse(`\\frac{d}{d${v}}\\left(${latex}\\right)`).evaluate();
    },
  },
  {
    id: 'integrate',
    label: 'Integrate',
    group: 'calculus',
    compute: (latex) => {
      if (isHeaded(latex, 'Integrate')) return ce.parse(latex).evaluate();
      const v = currentVariable();
      return parse(`\\int\\left(${latex}\\right)\\,d${v}`).evaluate();
    },
  },
  {
    id: 'series',
    label: 'Series',
    group: 'calculus',
    compute: (latex) => {
      const v = currentVariable();
      const about = seriesAboutInput.value.trim() || '0';
      const terms = seriesTermsInput.value.trim() || '4';
      return ce.parse(`\\operatorname{Series}(${latex}, ${v}, ${about}, ${terms})`).evaluate();
    },
  },
  { id: 'solve', label: 'Solve', group: 'solve', compute: (latex) => solve(latex, currentVariable()) },
  { id: 'inverse', label: 'Inverse', group: 'matrix', compute: (latex) => ce.box(['Inverse', ce.parse(latex)]).evaluate() },
  {
    id: 'determinant',
    label: 'Determinant',
    group: 'matrix',
    compute: (latex) => ce.box(['Determinant', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'transpose',
    label: 'Transpose',
    group: 'matrix',
    compute: (latex) => ce.box(['Transpose', ce.parse(latex)]).evaluate(),
  },
  { id: 'trace', label: 'Trace', group: 'matrix', compute: (latex) => ce.box(['Trace', ce.parse(latex)]).evaluate() },
  { id: 'rank', label: 'Rank', group: 'matrix', compute: (latex) => ce.box(['Rank', ce.parse(latex)]).evaluate() },
  {
    id: 'eigenvalues',
    label: 'Eigenvalues',
    group: 'matrix',
    compute: (latex) => ce.box(['Eigenvalues', ce.parse(latex)]).evaluate(),
  },
  {
    id: 'eigenvectors',
    label: 'Eigenvectors',
    group: 'matrix',
    compute: (latex) => ce.box(['Eigenvectors', ce.parse(latex)]).evaluate(),
  },
];

// Builds the "Morph" submenu for one field, showing only the operations valid for its current selection.
function buildMorphSubmenu(field) {
  return operations.map((op) => ({
    label: op.label,
    visible: () => visibleGroupsByKind[classifySelection(selectionLatexFor(field))].includes(op.group),
    onMenuSelect: () => {
      activeMathField = field;
      runOperation(op.compute);
    },
  }));
}

function installFieldMenu(field) {
  field.menuItems = [
    {
      label: 'Morph',
      submenu: buildMorphSubmenu(field),
      enabled: () => classifySelection(selectionLatexFor(field)) !== 'none',
    },
    { type: 'divider' },
    ...field.menuItems,
  ];
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

addLineBtn.addEventListener('click', () => {
  const lines = allLines();
  insertLineAfter(lines[lines.length - 1]);
});

const firstLine = createLine('x^2 + 2x + 1 = 0');
documentEl.append(firstLine);
const firstField = mathFieldIn(firstLine);
activeMathField = firstField;
firstField.focus();
