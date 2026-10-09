// Pinned to exact versions (rather than the unversioned/"latest" unpkg URLs) so a new upstream
// release can never silently change behaviour underneath the app - bumping these is a deliberate,
// testable choice. Keep in sync with the matching pinned URLs cached in sw.js.
import { MathfieldElement } from 'https://unpkg.com/mathlive@0.111.0?module';
import { ComputeEngine, parse, simplify, expand, factor, solve } from 'https://unpkg.com/@cortex-js/compute-engine@0.147.0?module';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

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

// Opening another window/tab (e.g. "Open in Graphiti", see buildExportMenu) leaves *that one*
// field - and only that field - permanently unable to accept physical keystrokes once the user
// switches back to this tab, even though it still looks and reports itself as focused. Unlike the
// similar-looking corruption rebuildMathField works around elsewhere in this file, recreating the
// element doesn't fix this particular case - only actually shifting real DOM focus somewhere else
// and back does, which is why this briefly borrows the scratch field above (already a real,
// always-present math-field, so a second visible line is never required) purely as a focus target.
let fieldToRecoverOnRefocus = null;
window.addEventListener('focus', () => {
  const field = fieldToRecoverOnRefocus;
  fieldToRecoverOnRefocus = null;
  if (!field || !field.isConnected) return;
  // Deferred a tick so this runs after the browser's own focus restoration (back to whichever
  // element was focused when the window lost it) has already settled, rather than racing it.
  setTimeout(() => {
    const position = field.position;
    scratchField.focus();
    field.focus();
    field.position = position;
  }, 0);
});

const themeToggleBtn = document.getElementById('theme-toggle');
const themeToggleLabel = document.getElementById('theme-toggle-label');
const themeToggleIcon = document.getElementById('theme-toggle-icon');
const headerMenuToggle = document.getElementById('header-menu-toggle');
const headerMenuDropdown = document.getElementById('header-menu-dropdown');

// Icon shows the mode a click will switch *to*, matching the adjacent label text.
const SUN_ICON = '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></g>';
const MOON_ICON = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';

// Shared by every small square "delete this" icon button (a document line, a saved snippet) so
// they all look and behave identically rather than drifting apart.
const DELETE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">' +
  '<line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';

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
const statusEl = document.getElementById('status');
const examplesHintEl = document.getElementById('examples-hint');

// Only relevant while the document still is the pre-populated worked examples - once the user
// changes anything (typing, adding/deleting a line, or applying a Morph operation), it's served
// its purpose and would just be clutter from then on.
function hideExamplesHint() {
  examplesHintEl.hidden = true;
}

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', Boolean(isError));
}

// Fires a GoatCounter custom event (see the script tag in index.html) - mirrors graphiti's own
// tracking helper. Safe to call even when GoatCounter hasn't loaded (e.g. ad blockers, offline).
function trackGoatCounterEvent(eventName) {
  try {
    if (!eventName) return;
    if (!window.goatcounter || typeof window.goatcounter.count !== 'function') return;

    const eventSlug = eventName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    window.goatcounter.count({
      path: `/event/${eventSlug}`,
      title: eventName,
      event: true,
    });
  } catch (error) {
    console.warn('GoatCounter tracking failed:', error);
  }
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
  return normalized;
}

function getSelectionLatex() {
  if (!activeMathField) return null;
  const live = selectionLatexFor(activeMathField);
  const cached = lastSelectionByField.get(activeMathField)?.latex || null;
  return live || cached || null;
}

// Re-applies the selection range captured before the menu blurred the field, so the upcoming
// replaceSelection() replaces the originally-selected text rather than inserting at the cursor.
function restoreSelectionIfNeeded(field) {
  if (!field || !field.selectionIsCollapsed) return;
  const cached = lastSelectionByField.get(field);
  if (cached) field.selection = { ranges: [cached.range] };
}

// MathLive's own Copy/Copy special commands only ever act on the current selection - with
// nothing selected, that would silently do nothing. Temporarily selecting the whole field first
// lets "run" fall back to the whole expression instead, then restores whatever the selection (or
// collapsed cursor position) was beforehand, so no visible selection is left behind afterwards.
function withWholeFieldSelectionIfNeeded(field, hasSelection, run) {
  if (hasSelection) {
    run();
    return;
  }
  const priorSelection = field.selection;
  field.executeCommand('selectAll');
  try {
    run();
  } finally {
    field.selection = priorSelection;
  }
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

// MathLive's own inline shortcut for \pm only recognises the literal "+" character (Shift+Equal)
// immediately followed by "-", and doesn't recognise the Numpad +/- keys at all (tested:
// NumpadSubtract never joins a shortcut sequence, whichever position it's in). Handling this
// ourselves instead additionally covers NumpadAdd followed by the "-/_" key or NumpadSubtract -
// unlike "=" (unshifted Equal), which deliberately isn't treated as a \pm trigger here, since
// "=-" is also exactly how an ordinary equation writes "equals negative" (e.g. "x=-7"), and
// that's far too common a pattern to risk hijacking.
const PLUS_MINUS_TIMEOUT_MS = 600;
const pendingPlusByField = new WeakMap();

function isPlusKeyEvent(ev) {
  return ev.code === 'NumpadAdd' || (ev.code === 'Equal' && ev.shiftKey);
}

function isMinusKeyEvent(ev) {
  return ev.code === 'Minus' || ev.code === 'NumpadSubtract';
}

// MathLive already recognises "floor"/"ceil" as inline shortcuts (built in), but has no
// equivalent for absolute value, modulus or complex conjugate - add them here on top of the
// defaults (rather than replacing field.inlineShortcuts outright) so everything else MathLive
// ships with keeps working. "#?" is MathLive's own token for "insert a \placeholder{} here".
const EXTRA_INLINE_SHORTCUTS = {
  abs: '\\left|#?\\right|',
  mod: '\\left|#?\\right|',
  conj: '\\overline{#?}',
};

// Wires up all the event listeners a line's math-field needs - shared by createLine() and
// rebuildMathField() (see the latter for why a field sometimes needs fully recreating rather
// than just reused).
function setupMathField(field, line) {
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
    // With nothing selected, the Morph submenu would be entirely empty - which is exactly the
    // state a new user hits right away (the hint says "right-click to Morph", but the default
    // example equation starts with no selection). Auto-selecting everything first mirrors the
    // touch-only field-menu button below (see menuBtn), which already does this unconditionally,
    // and gives an immediate visual cue (the whole equation highlights) for what's about to be
    // acted on.
    if (field.selectionIsCollapsed) field.executeCommand('selectAll');
    openFieldMenu(field, ev.clientX, ev.clientY);
  }, true);
  // menuItems requires the field to be connected to the DOM, which only happens after
  // the caller appends the returned line - defer until MathLive reports it's mounted.
  // (field.inlineShortcuts is also only readable/writable once mounted - reading it any
  // earlier throws "Mathfield not mounted".)
  field.addEventListener('mount', () => {
    field.inlineShortcuts = { ...field.inlineShortcuts, ...EXTRA_INLINE_SHORTCUTS };
    installFieldMenu(field);
    patchMatrixPickerHighlight(field);
    patchContentOverflow(field);
  }, { once: true });
  field.addEventListener('beforeinput', (ev) => {
    // Enter would otherwise insert a line break into the field - this app has no concept of a
    // multi-line equation, so swallow it and leave the field untouched (new lines are only ever
    // added explicitly, via "+ Add Equation" or the equivalent menu action).
    if (ev.inputType === 'insertLineBreak') {
      ev.preventDefault();
    }
  });
  field.addEventListener('keydown', (ev) => {
    // User-assigned Morph shortcuts (see userShortcuts above) - checked first since they always
    // require a modifier, so can never collide with the plain-key +/- handling just below.
    if (SHORTCUTS_SUPPORTED && (ev.ctrlKey || ev.metaKey)) {
      const opId = shortcutOpIdFor({ ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, key: ev.key.toLowerCase() });
      if (opId) {
        ev.preventDefault();
        triggerOperationById(opId, field);
        return;
      }
    }
    if (!ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      if (isPlusKeyEvent(ev)) {
        // Let the "+"/"=" character insert as usual - just remember it might be the start of a
        // \pm sequence, in case a "-"/"_"-like key follows soon after.
        pendingPlusByField.set(field, Date.now());
        return;
      }
      if (isMinusKeyEvent(ev)) {
        const pendingAt = pendingPlusByField.get(field);
        if (pendingAt && Date.now() - pendingAt <= PLUS_MINUS_TIMEOUT_MS) {
          pendingPlusByField.delete(field);
          ev.preventDefault();
          field.executeCommand('deleteBackward');
          field.insert('\\pm', { format: 'latex' });
          return;
        }
      }
    }
    pendingPlusByField.delete(field);
  });
}

// Creates one row of the document: a mathfield plus action buttons.
function createLine(initialLatex) {
  const line = document.createElement('div');
  line.className = 'doc-line';

  const field = document.createElement('math-field');
  field.value = initialLatex || '';

  const actions = document.createElement('div');
  actions.className = 'doc-line-actions';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-line';
  deleteBtn.setAttribute('aria-label', 'Delete line');
  deleteBtn.innerHTML = DELETE_ICON_SVG;
  deleteBtn.addEventListener('click', () => removeLine(line));

  // MathLive's own virtual keyboard toggle button works fine on desktop, but since its touch
  // behaviour has proven unreliable enough elsewhere to replace (see the menu button below),
  // it's replaced here too - on both desktop and touch - so this app no longer depends on
  // MathLive's own in-field buttons at all, and isn't at the mercy of their behaviour changing.
  //
  // Looks up the field fresh (via mathFieldIn(line)) rather than closing over the "field"
  // variable above: rebuildMathField() (see its own comment for why that's ever needed) replaces
  // *only* the <math-field> element itself, swapping a new one into the line in place of this
  // one - it doesn't recreate this button, so a captured reference would silently keep pointing
  // at the old, now-detached element forever after, frozen at whatever it last contained.
  const keyboardBtn = document.createElement('button');
  keyboardBtn.type = 'button';
  keyboardBtn.className = 'keyboard-toggle-btn';
  keyboardBtn.setAttribute('aria-label', 'Toggle virtual keyboard');
  keyboardBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2.5" y="6" width="19" height="12" rx="1.8"/>' +
    '<line x1="5.5" y1="9.5" x2="5.5" y2="9.5" stroke-width="2.4"/>' +
    '<line x1="9" y1="9.5" x2="9" y2="9.5" stroke-width="2.4"/>' +
    '<line x1="12.5" y1="9.5" x2="12.5" y2="9.5" stroke-width="2.4"/>' +
    '<line x1="16" y1="9.5" x2="16" y2="9.5" stroke-width="2.4"/>' +
    '<line x1="19.5" y1="9.5" x2="19.5" y2="9.5" stroke-width="2.4"/>' +
    '<line x1="7" y1="14.5" x2="17" y2="14.5"/></svg>';
  keyboardBtn.addEventListener('click', () => {
    const currentField = mathFieldIn(line);
    activeMathField = currentField;
    currentField.focus();
    currentField.executeCommand('toggleVirtualKeyboard');
  });

  // Shows the equation full-screen (see openBoardMode) for displaying to a class on a
  // projector/whiteboard - sits between the delete and keyboard/menu buttons (see the
  // space-between rule on .doc-line-actions, which centers it regardless of row height).
  const boardModeBtn = document.createElement('button');
  boardModeBtn.type = 'button';
  boardModeBtn.className = 'board-mode-btn';
  boardModeBtn.setAttribute('aria-label', 'Board mode');
  boardModeBtn.title = 'Show this equation full-screen';
  boardModeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="9 3 3 3 3 9"/><polyline points="15 3 21 3 21 9"/>' +
    '<polyline points="21 15 21 21 15 21"/><polyline points="3 15 3 21 9 21"/></svg>';
  boardModeBtn.addEventListener('click', () => openBoardMode(mathFieldIn(line)));

  // MathLive's touch handling is unreliable enough (long-press doesn't reach a "contextmenu"
  // event, and in practice doesn't reliably trigger a long-press gesture at all) that fighting
  // it isn't worth it - instead, touch devices get this dedicated button (hidden on desktop via
  // CSS) that opens the same menu directly. There's no reliable per-touch-device way to know
  // which part of the equation the user meant, so it simply selects the whole field first.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'field-menu-btn';
  menuBtn.setAttribute('aria-label', 'Open menu');
  menuBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
  menuBtn.addEventListener('click', () => {
    const currentField = mathFieldIn(line);
    activeMathField = currentField;
    currentField.focus();
    currentField.executeCommand('selectAll');
    const rect = menuBtn.getBoundingClientRect();
    openFieldMenu(currentField, rect.left, rect.bottom);
  });

  actions.append(deleteBtn, boardModeBtn, keyboardBtn, menuBtn);
  line.append(field, actions);

  setupMathField(field, line);

  return line;
}

// Replaces a line's math-field with a brand new element instance carrying the same value
// (preserving focus/cursor position if that field was the focused one) - see the big comment
// where this is called, near the end of this file, for why this is ever needed at all. A fresh
// instance is required, not just re-focusing or re-setting .value on the same element: neither
// of those (nor even removing and reinserting the same node) clears the corruption once it's
// happened, only swapping in a genuinely new <math-field> does.
function rebuildMathField(line) {
  const oldField = mathFieldIn(line);
  const wasActive = activeMathField === oldField;
  const hadFocus = oldField.hasFocus();
  const { value, position } = oldField;

  const newField = document.createElement('math-field');
  newField.value = value;
  oldField.replaceWith(newField);
  setupMathField(newField, line);

  if (wasActive) activeMathField = newField;
  if (hadFocus) {
    newField.focus();
    newField.position = position;
  }
}

function insertLineAfter(line) {
  const newLine = createLine('');
  line.after(newLine);
  mathFieldIn(newLine).focus();
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
  return allLines().map((line) => ({ latex: mathFieldIn(line).value }));
}

// Replaces the whole document with the given lines, keeping at least one (empty) line.
// `focus` defaults to true, but is set to false on startup when the About dialog is about to
// open immediately afterwards - there's no point focusing a field the dialog is about to take
// focus away from again anyway (see the startup code near the end of this file for the more
// important reason the dialog needs handling specially here at all).
function buildDocument(entries, { focus = true } = {}) {
  documentEl.innerHTML = '';
  const list = entries && entries.length ? entries : [{ latex: '' }];
  for (const entry of list) {
    const line = createLine(entry.latex || '');
    documentEl.append(line);
  }
  const firstField = mathFieldIn(documentEl.firstElementChild);
  activeMathField = firstField;
  if (focus) firstField.focus();
}

// Auto-persists the live document to localStorage, so it survives reloads/browser restarts. This
// is deliberately local-only, even when signed in - see the big comment above the cloud sync
// section further down for why only the snippet library is synced across devices.
let persistTimeout = null;
function schedulePersist() {
  hideExamplesHint();
  clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(serializeDocument()));
  }, 400);
}

const SNIPPETS_STORAGE_KEY = 'mathamorph-snippets';

function loadSnippets() {
  const raw = localStorage.getItem(SNIPPETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(err);
    return [];
  }
}

function saveSnippets(snippets) {
  localStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(snippets));
  pushSnippetsToCloud(snippets);
}

function createSnippetId() {
  return `snippet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// `category` groups/filters snippets in Manage Snippets and the Insert Snippet submenu.
// Deliberately optional, defaulting to '' - organising a snippet is never forced on the user at
// save time, and a blank category is a perfectly normal, permanent state rather than something
// that needs fixing later. See categoryLabel() below for how a blank category is displayed.
//
// `tags` isn't used by any UI yet, but is included from the start so that adding a separate
// free-form tagging feature later never needs a data migration - just a UI built on data that's
// already shaped for it.
function createSnippet(name, latex, category = '', tags = []) {
  return { id: createSnippetId(), name, latex, category, tags };
}

// Every snippet saved before this feature existed (and every one saved since, unless the user
// deliberately chose one) has no category - rather than writing a literal 'Uncategorised' into
// that snippet's own data the first time it's touched, that label is only ever computed here, at
// the point something needs to group or filter by category. That keeps a blank category
// genuinely blank in storage, and leaves no ambiguity if a user ever wants a category actually
// named 'Uncategorised'.
const UNCATEGORISED_LABEL = 'Uncategorised';
function categoryLabel(snippet) {
  return (snippet.category || '').trim() || UNCATEGORISED_LABEL;
}

// Distinct categories actually in use, sorted alphabetically - used to populate both the Save as
// snippet dialog's datalist and the Manage Snippets filter dropdown. Derived from the snippets
// themselves rather than kept as a separate list, so a category nothing uses any more just stops
// appearing on its own - there's never an empty, orphaned category left to clean up.
function distinctCategories(snippets) {
  const set = new Set(snippets.map((s) => (s.category || '').trim()).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

// --- Cloud sync (Google sign-in + Firestore) ---
// Snippets are opt-in-by-signing-in, not opt-in-by-a-separate-toggle: anyone who signs in
// obviously wants their library synced, so there's no extra "enable sync" step. Signed-out use
// is untouched - everything above this point already works entirely offline via localStorage,
// and that keeps working exactly as before for anyone who never signs in.
//
// Only the snippet library is synced - the live document (the scratchpad) deliberately isn't,
// even though an earlier version of this feature tried that too. Snippets are discrete, named,
// deliberately-saved items, so merging two devices' libraries (union by id) is always safe -
// nothing is ever silently discarded. The scratchpad has no such structure, just one mutable
// blob per device, so any cross-device sync of it reduces to "whichever write lands last wins" -
// which genuinely lost a user's work in practice (device A edits, then device B - which made no
// edits of its own, just happened to read a stale, pre-A-edit copy of the cloud - decided its
// own older content looked "newer than what it read" and pushed it, stomping A's edit once B's
// stale write reached the cloud after A's did). The scratchpad already autosaves to localStorage
// per-device regardless (see schedulePersist) - if it's worth keeping across devices, that's what
// the snippet library is for.
//
// The whole library is stored as a single field in one Firestore document per user
// (users/{uid}.snippets) - every mutation already funnels through saveSnippets() with the full
// array, so the entire sync layer hangs off that one function. setDoc uses { merge: true } so a
// snippets write can never clobber any other top-level field that might exist on the document.
//
// The apiKey/appId below aren't secrets - anyone can read them straight out of this file (or any
// Firebase web app's source) with no special access. What actually protects user data is the
// Firestore security rules (each user can only read/write their own users/{uid} document) and
// Google sign-in itself; hiding this config would do nothing for security.
const firebaseConfig = {
  apiKey: 'AIzaSyAIGXvu5t-RJZME3XbDgr2Op6GxD81f0EU',
  authDomain: 'mathamorph.firebaseapp.com',
  projectId: 'mathamorph',
  storageBucket: 'mathamorph.firebasestorage.app',
  messagingSenderId: '606066957457',
  appId: '1:606066957457:web:214fc7b31b80b407963330',
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

let currentUser = null;
let unsubscribeSnippetsListener = null;

// Pushes the full snippet array up to the signed-in user's Firestore document - a no-op while
// signed out. Fire-and-forget: the UI has already updated from the localStorage write above, so
// a slow or failed sync shouldn't block or roll back what the user just did locally, just surface
// it via the status line.
function pushSnippetsToCloud(snippets) {
  if (!currentUser) return;
  setDoc(doc(db, 'users', currentUser.uid), { snippets, snippetsUpdatedAt: serverTimestamp() }, { merge: true }).catch((err) => {
    console.error(err);
    showStatus('Could not sync snippets to your account - check your connection.', true);
  });
}

// Applies snippets that arrived *from* Firestore (initial load, merge, or another device's
// change via the realtime listener below) - writes straight to localStorage rather than through
// saveSnippets(), so receiving a cloud update never bounces straight back up as a redundant
// write. Skipped entirely when the incoming data is identical to what's already stored, so an
// echo of our own just-written change doesn't needlessly redraw an open Manage Snippets list.
function applyIncomingSnippets(snippets) {
  const incoming = JSON.stringify(snippets);
  if (incoming === JSON.stringify(loadSnippets())) return;
  localStorage.setItem(SNIPPETS_STORAGE_KEY, incoming);
  if (manageSnippetsDialog.open) renderManageSnippetsList();
}

// Two devices that each saved the same formula before either of them had ever signed in end up
// with the same snippet in substance but different (locally-generated) ids - matching the
// sign-in merge below by id alone treats that as two distinct snippets, re-adding what the user
// sees as "the same snippet" every time another of their devices first signs in. Comparing LaTeX
// instead (the part the user actually recognises as "this is the same snippet") catches that
// case too. Whitespace is ignored since MathLive can serialise visually identical input with
// trivial spacing differences.
function normalizeLatexForDedup(latex) {
  return (latex || '').replace(/\s+/g, '');
}

function updateAuthMenuUI() {
  authToggleLabel.textContent = currentUser ? 'Sign out' : 'Sign in to sync snippets';
  authToggleBtn.title = currentUser
    ? `Signed in as ${currentUser.email}`
    : 'Sign in with your Google account to sync your snippet library';
  authToggleIcon.classList.toggle('auth-icon-signed-in', Boolean(currentUser));
  authToggleIcon.classList.toggle('auth-icon-signed-out', !currentUser);
}

const authToggleBtn = document.getElementById('auth-toggle');
const authToggleLabel = document.getElementById('auth-toggle-label');
const authToggleIcon = document.getElementById('auth-toggle-icon');

authToggleBtn.addEventListener('click', () => {
  if (currentUser) {
    signOut(auth);
  } else {
    signInWithPopup(auth, googleProvider).catch((err) => {
      console.error(err);
      // Not real failures - just the user dismissing the Google popup themselves.
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      showStatus('Sign-in failed - please try again.', true);
    });
  }
  closeHeaderMenu();
});

onAuthStateChanged(auth, async (user) => {
  if (unsubscribeSnippetsListener) {
    unsubscribeSnippetsListener();
    unsubscribeSnippetsListener = null;
  }
  currentUser = user;
  updateAuthMenuUI();
  if (!user) return;

  const userDocRef = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(userDocRef);
    if (!snap.exists()) {
      // First-ever sign-in for this account - seed the cloud with whatever's already local
      // rather than starting from an empty library.
      await setDoc(userDocRef, { snippets: loadSnippets(), snippetsUpdatedAt: serverTimestamp() });
    } else {
      // Signing in on a device that already has local snippets the cloud doesn't know about yet
      // (e.g. first sign-in on a second device): merge rather than silently discarding either
      // side - union by id (falling back to a LaTeX match, see normalizeLatexForDedup above, for
      // snippets independently created on two devices before either had ever synced), then push
      // the merged result back up.
      const cloudSnippets = Array.isArray(snap.data().snippets) ? snap.data().snippets : [];
      const cloudIds = new Set(cloudSnippets.map((s) => s.id));
      const cloudLatexes = new Set(cloudSnippets.map((s) => normalizeLatexForDedup(s.latex)));
      const localOnly = loadSnippets().filter(
        (s) => !cloudIds.has(s.id) && !cloudLatexes.has(normalizeLatexForDedup(s.latex))
      );
      const mergedSnippets = [...cloudSnippets, ...localOnly];
      applyIncomingSnippets(mergedSnippets);
      if (localOnly.length > 0) {
        await setDoc(userDocRef, { snippets: mergedSnippets, snippetsUpdatedAt: serverTimestamp() }, { merge: true });
      }
    }
  } catch (err) {
    console.error(err);
    showStatus('Could not load your synced snippets.', true);
  }

  // From here on, any change made on *another* signed-in device arrives here live - no manual
  // "refresh" or re-opening the app needed.
  unsubscribeSnippetsListener = onSnapshot(
    userDocRef,
    (snap) => {
      if (!snap.exists()) return;
      applyIncomingSnippets(Array.isArray(snap.data().snippets) ? snap.data().snippets : []);
    },
    (err) => console.error(err)
  );
});

// A brand-new document has nothing to demonstrate the "right-click to morph" hint with - seed
// it with a few worked examples on the very first run, each ready to showcase a different kind
// of operation straight away: an equation to Solve, a factored cubic to Expand, and a definite
// integral to Integrate.
const DEFAULT_DOCUMENT_ENTRIES = [
  { latex: 'x^2 + 2x + 1 = 0' },
  { latex: '(x-1)(x-2)(x-3)' },
  { latex: '\\int_{0}^{2}\\left(x^2+1\\right)dx' },
];

// A persisted document with no lines, or with only blank ones (e.g. because the user deleted
// every equation they had), has nothing left to demonstrate the "right-click to morph" hint with
// either - functionally indistinguishable from a brand-new session, so treat it the same way.
function isBlankDocument(entries) {
  return !entries || !entries.some((entry) => entry.latex && entry.latex.trim());
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
  const usingDefaults = isBlankDocument(entries);
  // Blank lines left over from mid-session editing (e.g. an equation deleted, or a fresh
  // "+ Add Equation" line never filled in) have nothing worth restoring - drop them so the
  // remaining equations are compacted to the front rather than restored with gaps between them.
  const nonBlankEntries = usingDefaults ? null : entries.filter((entry) => entry.latex && entry.latex.trim());
  buildDocument(usingDefaults ? DEFAULT_DOCUMENT_ENTRIES : nonBlankEntries, {
    focus: !shouldShowAboutOnStartup(),
  });
  examplesHintEl.hidden = !usingDefaults;
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

function isUnresolvedMatrixOp(result) {
  if (Array.isArray(result)) return result.some(isUnresolvedMatrixOp);
  const json = result && result.json;
  return Array.isArray(json) && UNRESOLVED_MATRIX_HEADS.has(json[0]);
}

// Compute Engine doesn't throw for LaTeX it can't parse (e.g. notation it doesn't support, like
// "\bigm|" for evaluating at a point) - it embeds an ["Error", ...] node in the result's JSON
// instead, anywhere in the tree, and happily serializes that back out as valid-looking LaTeX
// (MathLive's own "\error{...}" marker) that isWellFormedLatex() below doesn't catch either,
// since showing an error marker isn't itself a MathLive parse error. Left undetected, that
// literal "\error{...}" markup would otherwise silently overwrite the user's original selection.
function containsErrorNode(json) {
  if (!Array.isArray(json)) return false;
  if (json[0] === 'Error') return true;
  return json.some(containsErrorNode);
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

  if (isUnresolvedMatrixOp(result)) {
    showStatus(
      'Could not compute a result - check the matrix is square and, for Inverse, that its determinant is not zero.',
      true,
    );
    return;
  }

  if (containsErrorNode(Array.isArray(result) ? result.map((r) => r && r.json) : result && result.json)) {
    showStatus('Could not understand part of that selection - it may use notation that isn\'t supported.', true);
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
  trackGoatCounterEvent('Mathamorph - morph applied');
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

// "Open in Graphiti" only makes sense for a genuine equation (not a bare expression, and not an
// inequality) whose free variables are entirely the cartesian x/y pair or entirely the polar
// r/theta pair - anything else (extra parameters, mismatched variables, etc.) isn't something
// Graphiti's plotter can do anything useful with.
const GRAPHITI_CARTESIAN_VARS = new Set(['x', 'y']);
const GRAPHITI_POLAR_VARS = new Set(['r', 'theta']);
function graphitiModeFor(latex) {
  if (!latex || !latex.trim()) return null;
  let unknowns;
  try {
    if (!isHeaded(latex, 'Equal')) return null;
    unknowns = freeVariablesOf(latex);
  } catch {
    return null;
  }
  if (unknowns.length === 0) return null;
  if (unknowns.every((v) => GRAPHITI_CARTESIAN_VARS.has(v))) return 'cartesian';
  if (unknowns.every((v) => GRAPHITI_POLAR_VARS.has(v))) return 'polar';
  return null;
}

// Graphiti reads its shared-graph state from a "#v=" URL fragment: an LZString-compressed JSON
// blob containing one function entry plus which mode (cartesian/polar) to plot it in - see
// loadLZString for why the compression library itself is loaded lazily rather than up front.
function buildGraphitiUrl(LZString, latex, mode) {
  const state = {
    v: 1,
    functions: [{ id: 1, expression: latex, color: '#4A90E2', enabled: true }],
    mode,
  };
  const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(state));
  return `https://www.korovatron.co.uk/graphiti/#v=${compressed}`;
}

// "Open in Komplexiti" only makes sense for a genuine equation (not a bare expression, and not
// an inequality) in exactly one free variable - Komplexiti's Argand-diagram plotter treats that
// single unknown as the complex variable, whatever letter it's actually called (z, w, ...).
function isKomplexitiEquation(latex) {
  if (!latex || !latex.trim()) return false;
  try {
    if (!isHeaded(latex, 'Equal')) return false;
    return freeVariablesOf(latex).length === 1;
  } catch {
    return false;
  }
}

// Komplexiti reads its shared-diagram state from the same kind of "#v=" URL fragment as
// Graphiti (see checkAndApplySharedState in Komplexiti's own main.js) - an LZString-compressed
// JSON blob listing the expression card(s) to pre-load. cardRootFmt/color/colorMode are all left
// unset here so Komplexiti falls back to its own defaults (cartesian roots, auto-assigned color).
function buildKomplexitiUrl(LZString, latex) {
  const state = {
    v: 1,
    expressions: [{ latex }],
  };
  const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(state));
  return `https://www.korovatron.co.uk/komplexiti/#v=${compressed}`;
}

// Loaded on demand (only once "Open in Graphiti"/"Open in Komplexiti" is actually used) rather
// than unconditionally up front - mirrors loadMathJax below. Pinned to the exact same version
// and CDN both apps themselves load (see sw.js for the matching cached URL), so the compressed
// state format is guaranteed to round-trip through either app's decoder unchanged.
let lzStringReadyPromise = null;
function loadLZString() {
  if (!lzStringReadyPromise) {
    lzStringReadyPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js';
      script.onload = () => resolve(window.LZString);
      script.onerror = () => reject(new Error('Could not load LZString.'));
      document.head.appendChild(script);
    });
  }
  return lzStringReadyPromise;
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

// Simplify, Evaluate and Solve are generic enough, and reached for often enough, that they're
// worth showing directly inside the "Morph" submenu rather than making every use wait through
// an "Algebra" sub-submenu too - every other operation is specific enough to a particular kind
// of selection that the extra click costs little. These are shown above the category
// sub-submenus (see MORPH_CATEGORIES), and excluded from them to avoid duplication.
const MORPH_TOP_LEVEL_IDS = ['simplify', 'evaluate', 'solve'];

// --- User-assignable keyboard shortcuts for Morph operations --------------------------------
//
// There are deliberately no shipped defaults here (see the commit history for why: a prototype
// with fixed Ctrl+Shift+<letter> defaults turned out to collide with real, pre-installed
// software - specifically AMD's Adrenalin overlay - on real hardware, which a web page has no
// way to detect or avoid in advance, since global hotkeys are intercepted by the OS before a
// page's own JavaScript ever sees the keystroke). Letting each user assign their own combo
// instead means whatever's already claimed on their particular machine is simply irrelevant -
// they pick something else, and find out immediately (the assignment UI captures a real
// keypress, so if something else swallows it, nothing visibly happens - an immediate, honest
// signal rather than a shortcut that silently fails later).

// Keyboard shortcuts are meaningless without a physical keyboard. Checking for an actual touch
// device (e.g. `maxTouchPoints`) would also hide this on touchscreen laptops that have a perfectly
// good keyboard attached too - `any-pointer: fine` instead asks "is there a precise pointer
// available at all", which stays true on exactly those hybrid devices and only goes false on
// phones/tablets. Those devices only ever reach this menu via a long-press anyway (see the
// touch-only field-menu button), and can already run every operation that way with no keyboard
// involved at all, so there's nothing lost by hiding the assignment UI there.
const SHORTCUTS_SUPPORTED = window.matchMedia('(any-pointer: fine)').matches;

const SHORTCUTS_STORAGE_KEY = 'mathamorph-shortcuts';

function loadShortcuts() {
  const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error(err);
    return {};
  }
}

function saveShortcuts(shortcuts) {
  localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
}

// { [operationId]: { ctrlKey, shiftKey, altKey, metaKey, key } } - key is the lowercased
// KeyboardEvent.key of whatever non-modifier key completed the combo.
let userShortcuts = loadShortcuts();

// A string uniquely identifying a modifier+key combination, for comparing two combos (or
// looking one up) regardless of where the booleans came from (a stored assignment, or a live
// keydown event).
function comboSignature(combo) {
  return `${combo.ctrlKey ? 1 : 0}${combo.shiftKey ? 1 : 0}${combo.altKey ? 1 : 0}${combo.metaKey ? 1 : 0}:${combo.key.toLowerCase()}`;
}

// Human-readable form of a combo for display - reflects whatever modifiers were actually
// pressed (Cmd vs Ctrl) rather than assuming a platform, since the combo itself was captured
// directly from a real keystroke rather than chosen from a cross-platform-aware picker.
function comboLabel(combo) {
  const parts = [];
  if (combo.ctrlKey) parts.push('Ctrl');
  if (combo.metaKey) parts.push('Cmd');
  if (combo.altKey) parts.push('Alt');
  if (combo.shiftKey) parts.push('Shift');
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join('+');
}

// Which (if any) other operation already has this exact combo assigned - used both to warn
// before silently stealing it, and by the keydown dispatcher to find what to run.
function shortcutOpIdFor(combo) {
  const sig = comboSignature(combo);
  return Object.keys(userShortcuts).find((opId) => comboSignature(userShortcuts[opId]) === sig) || null;
}

// Combos MathLive itself already binds by default (extracted from its own shortcuts table -
// see the "list of keyboard shortcuts" link in the Help dialog) - assigning one of these still
// works, it just also silently shadows whatever MathLive normally does with it while a math
// field is focused, which is worth a heads-up rather than a silent surprise.
const MATHLIVE_RESERVED_SIGNATURES = new Set([
  ...['a', 'b', 'c', 'd', 'e', 'f', 'h', 'l', 'n', 'p', 'v', 'x', 'y', 'z'].map((k) => comboSignature({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: k })),
  ...['a', 'b', 'e', 'f', 'n', 'p', 'z'].map((k) => comboSignature({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: k })),
  ...['a', 'c', 'v', 'x', 'z'].map((k) => comboSignature({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, key: k })),
  ...['y', 'z'].map((k) => comboSignature({ ctrlKey: false, shiftKey: true, altKey: false, metaKey: true, key: k })),
]);

// Checks a freshly-captured combo for anything worth telling the user about before it's saved.
// `blocking: true` means it was never saved at all (shown inline, capture stays live so they can
// just try another combo); anything else is saved anyway (see the module comment above for why
// this app only ever warns rather than blocks for conflicts it can't be fully sure matter) but
// still worth flagging inline.
function checkComboConcerns(combo, assigningOpId) {
  if (!combo.ctrlKey && !combo.metaKey) {
    return { blocking: true, message: 'A shortcut needs to include Ctrl (or Cmd) so it never clashes with ordinary typing.' };
  }
  const conflictingOpId = shortcutOpIdFor(combo);
  if (conflictingOpId && conflictingOpId !== assigningOpId) {
    const label = operations.find((op) => op.id === conflictingOpId)?.label || conflictingOpId;
    return { blocking: false, message: `Already assigned to "${label}" - saving will remove it from there.` };
  }
  if (MATHLIVE_RESERVED_SIGNATURES.has(comboSignature(combo))) {
    return { blocking: false, message: 'MathLive already uses this combination by default - this will override that while a math field is focused.' };
  }
  if ((combo.ctrlKey || combo.metaKey) && combo.altKey && !combo.shiftKey) {
    return { blocking: false, message: 'Ctrl+Alt can be hard to type on some non-US keyboards (it\u2019s indistinguishable from AltGr) - consider adding Shift too.' };
  }
  return null;
}

// Runs an operation by id exactly as the Morph menu itself would (see buildOperationMenuItem) -
// shared by the keyboard-shortcut dispatcher below, since both need identical behaviour,
// including Series opening its dialog and Solve/Differentiate/Integrate falling back to a
// best-guess variable (there's no interactive picker available from a keydown event).
function triggerOperationById(opId, field) {
  const op = operations.find((candidate) => candidate.id === opId);
  if (!op) return;
  activeMathField = field;
  if (field.selectionIsCollapsed) field.executeCommand('selectAll');
  const unknowns = freeVariablesOf(getSelectionLatex() || '');
  if (op.id === 'series') {
    openSeriesDialog(field, unknowns);
    return;
  }
  if (op.needsVariable) {
    const variable = bestGuessVariable(unknowns);
    runOperation((latex) => op.compute(latex, variable));
    return;
  }
  runOperation(op.compute);
}

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

// Keeps the menu fully on-screen - needed not just once when it first opens, but every time a
// submenu toggle changes its rendered height (expanding a long one, like "Insert", can make the
// whole menu far taller than it was when its position was first computed, pushing its bottom -
// and the scrollbar needed to reach anything below the fold - off the bottom of the viewport).
function clampFieldMenuToViewport() {
  const rect = fieldMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
  fieldMenu.style.left = `${left}px`;
  fieldMenu.style.top = `${top}px`;
}

// Some of MathLive's own menu item labels are lazy getter functions (for localisation)
// rather than plain strings - resolve either form to display text.
function resolveLabel(item) {
  return typeof item?.label === 'function' ? item.label() : item?.label;
}

// Line-style icons (24x24, stroke=currentColor) for the menu's common, universally-recognisable
// actions, matching the header hamburger menu's own icon style (see header-menu-icon in
// index.html) - deliberately not attempted for the math operations themselves (Simplify, Factor,
// Differentiate, etc.), which have no similarly obvious one-glyph icon; their rows still line up
// with every other row via the same reserved icon slot (see createMenuIconSlot), just left empty.
const MENU_ICON_CUT =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="18" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="7.6" x2="20" y2="19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="8" y1="16.4" x2="20" y2="5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MENU_ICON_COPY =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MENU_ICON_PASTE =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="13" height="17" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="2.3" width="6" height="3" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="11" x2="16" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="15" x2="16" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const MENU_ICON_IMAGE =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.3" cy="9.3" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 16.5l4.5-4.5 3.3 3.3 2.4-2.4 4.3 4.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MENU_ICON_DOWNLOAD =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 10.5 12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 16.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MENU_ICON_PLUS =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MENU_ICON_FOLDER =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const MENU_ICON_SAVE =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const MENU_ICON_MODE =
  '<svg class="morph-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8.5" width="18" height="7" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16" cy="12" r="2.4" fill="currentColor"/></svg>';
// Two curved arrows cycling into one another - standing in for "transform/morph" the way a
// refresh icon stands in for "reload", since none of Simplify/Solve/etc. share one obvious glyph.
const MENU_ICON_MORPH =
  '<svg class="morph-menu-icon morph-menu-icon-morph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11a7 7 0 0 1 12-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 4.5V7.5h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 13a7 7 0 0 1-12 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 19.5V16.5h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GRAPHITI_MENU_ICON = '<img src="images/graphitiLogo.png" alt="" class="morph-menu-icon" />';
const KOMPLEXITI_MENU_ICON = '<img src="images/komplexitiLogo.png" alt="" class="morph-menu-icon" />';

// Every menu row reserves this same slot before its label - whether or not it actually has an
// icon - so every row lines up at a consistent indent regardless of which ones do (matching the
// header hamburger menu's look). `icon` is a ready-made HTML string (one of the MENU_ICON_*
// constants above, or GRAPHITI_MENU_ICON), or omitted/falsy to leave the slot visually empty.
function createMenuIconSlot(icon) {
  const span = document.createElement('span');
  span.className = 'morph-menu-icon-slot';
  if (icon) span.innerHTML = icon;
  return span;
}

function addMenuDivider(menu) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  li.className = 'morph-menu-divider';
  menu.appendChild(li);
}

// icon optionally renders a small icon (see createMenuIconSlot) before the label text.
function addMenuButton(menu, label, onActivate, title, icon) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'morph-menu-item';
  button.setAttribute('role', 'menuitem');
  if (title) button.title = title;
  button.appendChild(createMenuIconSlot(icon));
  button.appendChild(document.createTextNode(label));
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
// optionally {icon} (see createMenuIconSlot), {html: true} to render a raw HTML label (for the
// math template previews reused from MathLive's own "Insert" menu) instead of plain text - these
// already carry their own visual, so never get an icon slot - {heading: 'Section title'} for a
// non-interactive section label splitting up a long list of items (also borrowed from there),
// {submenu: [...]} to nest another expandable level (e.g. Differentiate/Integrate/Solve, when a
// selection has more than one candidate variable to pick from), {divider: true} for a plain
// separator line, or {widget: (ul) => void} to append arbitrary custom content (e.g. the matrix
// size picker grid) instead of a standard item - title sets a tooltip on this submenu's own
// toggle button, and icon likewise optionally gives the toggle button itself an icon.
function addSubmenu(menu, label, items, title, icon) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'morph-menu-item morph-submenu-toggle';
  toggle.setAttribute('role', 'menuitem');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  if (title) toggle.title = title;
  toggle.appendChild(createMenuIconSlot(icon));
  toggle.appendChild(document.createTextNode(label));

  const submenu = document.createElement('ul');
  submenu.className = 'morph-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.hidden = true;
  // Reserve space for a tick mark on every item if any item in this submenu uses one, so
  // unchecked items don't shift when a different one becomes checked.
  if (items.some((item) => 'checked' in item)) submenu.classList.add('morph-submenu-checkable');

  for (const item of items) {
    if (item.widget) {
      item.widget(submenu);
      continue;
    }

    const subLi = document.createElement('li');
    subLi.setAttribute('role', 'none');

    if (item.heading) {
      subLi.className = 'morph-submenu-heading';
      subLi.textContent = item.heading;
      submenu.appendChild(subLi);
      continue;
    }

    if (item.divider) {
      subLi.className = 'morph-menu-divider';
      submenu.appendChild(subLi);
      continue;
    }

    if (item.submenu) {
      addSubmenu(submenu, item.label, item.submenu, item.description, item.icon);
      continue;
    }

    if (item.opId && SHORTCUTS_SUPPORTED) {
      subLi.appendChild(buildAssignableMenuRow(item));
      submenu.appendChild(subLi);
      continue;
    }

    const subButton = document.createElement('button');
    subButton.type = 'button';
    subButton.className = 'morph-menu-item';
    subButton.classList.toggle('morph-menu-item-checked', Boolean(item.checked));
    subButton.setAttribute('role', 'checked' in item ? 'menuitemradio' : 'menuitem');
    if ('checked' in item) subButton.setAttribute('aria-checked', String(Boolean(item.checked)));
    if (item.description) subButton.title = item.description;
    if (item.html) {
      // Already carries its own visual (a rendered math preview) - no icon slot needed.
      subButton.innerHTML = item.label;
    } else if ('checked' in item) {
      // Uses the tick-mark-on-the-left mechanism (see morph-submenu-checkable in style.css)
      // instead of an icon slot, so the two don't stack into a doubly-indented row.
      subButton.textContent = item.label;
    } else {
      subButton.appendChild(createMenuIconSlot(item.icon));
      subButton.appendChild(document.createTextNode(item.label));
    }
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
    clampFieldMenuToViewport();
  });

  li.append(toggle, submenu);
  menu.appendChild(li);
  return li;
}

// Builds a menu row for an assignable Morph operation as two independently-clickable regions
// (rather than the single <button> every other row uses) - the label/icon side runs the
// operation as normal, the right-aligned shortcut side opens the assignment dialog. These have
// to be genuinely separate elements, not one button with a nested one (invalid HTML, and an
// ambiguous click target) - see openAssignShortcutDialog for the dialog itself.
function buildAssignableMenuRow(item) {
  const row = document.createElement('div');
  row.className = 'morph-menu-item-row';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'morph-menu-item-trigger';
  trigger.setAttribute('role', 'menuitem');
  if (item.description) trigger.title = item.description;
  trigger.appendChild(createMenuIconSlot(item.icon));
  trigger.appendChild(document.createTextNode(item.label));
  trigger.addEventListener('click', () => {
    item.onActivate();
    closeFieldMenu();
  });

  const shortcutBtn = document.createElement('button');
  shortcutBtn.type = 'button';
  shortcutBtn.className = 'morph-menu-shortcut-btn';
  refreshShortcutButton(shortcutBtn, item);
  shortcutBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openAssignShortcutDialog(item.opId, item.label);
  });

  row.append(trigger, shortcutBtn);
  return row;
}

// Updates a shortcut button's label/style/tooltip to reflect the current assignment (or lack of
// one).
function refreshShortcutButton(shortcutBtn, item) {
  const assigned = userShortcuts[item.opId];
  shortcutBtn.textContent = assigned ? comboLabel(assigned) : 'Add shortcut';
  shortcutBtn.classList.toggle('morph-menu-shortcut-btn-unassigned', !assigned);
  const description = assigned
    ? `Keyboard shortcut for ${item.label}: ${comboLabel(assigned)} - click to change or remove`
    : `Add a keyboard shortcut for ${item.label}`;
  shortcutBtn.title = description;
  shortcutBtn.setAttribute('aria-label', description);
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

// All <dialog> elements in this file already close on Escape (free, built-in) and on submitting
// their <form method="dialog"> (e.g. pressing Space/Enter on a focused button) - this adds the
// third expected way to dismiss one: clicking outside it. A plain `ev.target === dialog` check
// would also trigger on clicks inside the dialog's own padding (its content doesn't fill the box),
// so compare against its actual bounding box instead - only a click truly outside that counts.
function enableClickOutsideToClose(dialog) {
  dialog.addEventListener('click', (ev) => {
    const rect = dialog.getBoundingClientRect();
    const inside =
      ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}

// None of these fields are credentials, but password managers (LastPass especially) sometimes
// decorate plain text inputs with their own icon/autofill suggestions anyway - these are the
// documented attributes to opt back out across the major ones. Exposed both as a pre-joined
// string (for template-literal markup) and a setter (for inputs built via createElement).
const NO_PASSWORD_MANAGER_ATTR_LIST = [
  ['autocomplete', 'off'],
  ['data-lpignore', 'true'],
  ['data-1p-ignore', 'true'],
  ['data-bwignore', 'true'],
  ['data-form-type', 'other'],
];
const NO_PASSWORD_MANAGER_ATTRS = NO_PASSWORD_MANAGER_ATTR_LIST.map(([name, value]) => `${name}="${value}"`).join(' ');
function applyNoPasswordManagerAttrs(input) {
  for (const [name, value] of NO_PASSWORD_MANAGER_ATTR_LIST) input.setAttribute(name, value);
}

// The keyboard-capture UI for assigning a Morph operation's shortcut (see userShortcuts above) -
// a single shared dialog reused for every operation, like seriesDialog below. Rather than a
// structured picker (modifier checkboxes + a key dropdown), the user presses the actual
// combination they want: that's what makes this self-testing - if something on their machine
// (another app's global hotkey) is already intercepting that combination, nothing will visibly
// happen when they press it here, immediately, rather than the shortcut silently failing later
// when they try to rely on it.
const shortcutDialog = document.createElement('dialog');
shortcutDialog.className = 'app-dialog shortcut-dialog';
shortcutDialog.innerHTML = `
  <h2 class="shortcut-dialog-title">Shortcut</h2>
  <p class="shortcut-dialog-hint">Press the key combination you want to use - it must include Ctrl (or Cmd). Press Esc to cancel.</p>
  <div class="shortcut-capture-box" tabindex="0" role="button"></div>
  <p class="shortcut-dialog-warning" hidden></p>
  <div class="app-dialog-actions">
    <button type="button" class="shortcut-dialog-clear">Clear shortcut</button>
    <button type="button" class="shortcut-dialog-close app-dialog-primary">Close</button>
  </div>
`;
document.body.appendChild(shortcutDialog);
enableClickOutsideToClose(shortcutDialog);
const shortcutDialogTitle = shortcutDialog.querySelector('.shortcut-dialog-title');
const shortcutCaptureBox = shortcutDialog.querySelector('.shortcut-capture-box');
const shortcutDialogWarning = shortcutDialog.querySelector('.shortcut-dialog-warning');
const shortcutDialogClear = shortcutDialog.querySelector('.shortcut-dialog-clear');
shortcutDialog.querySelector('.shortcut-dialog-close').addEventListener('click', () => shortcutDialog.close());

const SHORTCUT_PLACEHOLDER_TEXT = 'Press a key combination\u2026';
const MODIFIER_ONLY_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
let assignShortcutOpId = null;

function renderShortcutDialogIdle() {
  const existing = userShortcuts[assignShortcutOpId];
  shortcutCaptureBox.textContent = existing ? comboLabel(existing) : SHORTCUT_PLACEHOLDER_TEXT;
  shortcutCaptureBox.classList.toggle('shortcut-capture-box-empty', !existing);
  shortcutDialogWarning.hidden = true;
  shortcutDialogWarning.classList.remove('shortcut-dialog-warning-blocking');
  shortcutDialogClear.hidden = !existing;
}

// While a modifier is held but the combo isn't complete yet (no regular key pressed alongside
// it), show what's building up so far - purely visual, nothing is captured until a non-modifier
// key arrives.
function livePreviewFor(ev) {
  const parts = [];
  if (ev.ctrlKey) parts.push('Ctrl');
  if (ev.metaKey) parts.push('Cmd');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  return parts.length ? `${parts.join('+')}+\u2026` : SHORTCUT_PLACEHOLDER_TEXT;
}

function handleShortcutCaptureKeydown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  // <dialog> elements close on Escape for free, but that relies on the keydown's default
  // action - which the preventDefault() above just suppressed, so it's re-done by hand here.
  if (ev.key === 'Escape') {
    shortcutDialog.close();
    return;
  }
  if (MODIFIER_ONLY_KEYS.has(ev.key)) {
    shortcutCaptureBox.textContent = livePreviewFor(ev);
    return;
  }

  const combo = { ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, key: ev.key.toLowerCase() };
  const concern = checkComboConcerns(combo, assignShortcutOpId);
  if (concern?.blocking) {
    shortcutCaptureBox.textContent = SHORTCUT_PLACEHOLDER_TEXT;
    shortcutDialogWarning.hidden = false;
    shortcutDialogWarning.textContent = concern.message;
    shortcutDialogWarning.classList.add('shortcut-dialog-warning-blocking');
    return;
  }

  // Assigning a combo already used elsewhere moves it here rather than leaving a stale
  // duplicate behind - checkComboConcerns above already warned about exactly this case.
  const sig = comboSignature(combo);
  for (const otherId of Object.keys(userShortcuts)) {
    if (otherId !== assignShortcutOpId && comboSignature(userShortcuts[otherId]) === sig) delete userShortcuts[otherId];
  }
  userShortcuts[assignShortcutOpId] = combo;
  saveShortcuts(userShortcuts);

  shortcutCaptureBox.textContent = comboLabel(combo);
  shortcutCaptureBox.classList.remove('shortcut-capture-box-empty');
  shortcutDialogClear.hidden = false;
  shortcutDialogWarning.classList.remove('shortcut-dialog-warning-blocking');
  shortcutDialogWarning.hidden = !concern;
  if (concern) shortcutDialogWarning.textContent = `\u26a0\ufe0f ${concern.message}`;
}

shortcutDialogClear.addEventListener('click', () => {
  delete userShortcuts[assignShortcutOpId];
  saveShortcuts(userShortcuts);
  renderShortcutDialogIdle();
});

shortcutDialog.addEventListener('close', () => {
  shortcutCaptureBox.removeEventListener('keydown', handleShortcutCaptureKeydown);
});

function openAssignShortcutDialog(opId, opLabel) {
  closeFieldMenu();
  assignShortcutOpId = opId;
  shortcutDialogTitle.textContent = `Shortcut for ${opLabel}`;
  renderShortcutDialogIdle();
  shortcutCaptureBox.addEventListener('keydown', handleShortcutCaptureKeydown);
  shortcutDialog.showModal();
  shortcutCaptureBox.focus();
}

// Series needs three pieces of information (variable, expansion point, truncation order) rather
// than the single variable Differentiate/Integrate/Solve need, so a quick variable-picker
// submenu doesn't fit it as well - it always opens this small dialog instead, pre-filled with
// sensible defaults (the detected variable, about 0, order 4) that can be overridden.
const seriesDialog = document.createElement('dialog');
seriesDialog.className = 'app-dialog series-dialog';
seriesDialog.innerHTML = `
  <form method="dialog">
    <h2>Series</h2>
    <div class="app-dialog-field">
      <label for="series-dialog-variable">Variable</label>
      <input id="series-dialog-variable" type="text" ${NO_PASSWORD_MANAGER_ATTRS} />
    </div>
    <div class="app-dialog-field">
      <label for="series-dialog-about">About</label>
      <input id="series-dialog-about" type="text" ${NO_PASSWORD_MANAGER_ATTRS} />
    </div>
    <div class="app-dialog-field">
      <label for="series-dialog-order" title="The highest power of the variable to expand up to - not a count of terms, since some powers may not appear (e.g. a series with only odd powers).">Order</label>
      <input id="series-dialog-order" type="text" ${NO_PASSWORD_MANAGER_ATTRS} />
    </div>
    <div class="app-dialog-actions">
      <button type="button" class="series-dialog-cancel">Cancel</button>
      <button type="submit" value="compute" class="app-dialog-primary">Compute</button>
    </div>
  </form>
`;
document.body.appendChild(seriesDialog);
enableClickOutsideToClose(seriesDialog);
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

// A small dialog, in the same style as the Series one above, that prompts for a name and saves
// whatever LaTeX was captured when "Save as snippet" was clicked (the selection, or the whole
// field if nothing was selected) into the snippet library.
const saveSnippetDialog = document.createElement('dialog');
saveSnippetDialog.className = 'app-dialog snippet-dialog';
saveSnippetDialog.innerHTML = `
  <form method="dialog">
    <h2>Save as snippet</h2>
    <div class="app-dialog-field">
      <label for="snippet-dialog-name">Name</label>
      <input id="snippet-dialog-name" type="text" ${NO_PASSWORD_MANAGER_ATTRS} required />
    </div>
    <div class="app-dialog-field">
      <label for="snippet-dialog-category">Category <span class="app-dialog-field-optional">(optional)</span></label>
      <select id="snippet-dialog-category" class="themed-select"></select>
      <input id="snippet-dialog-new-category" class="snippet-new-category-input" type="text" placeholder="New category name" hidden ${NO_PASSWORD_MANAGER_ATTRS} />
    </div>
    <div class="app-dialog-actions">
      <button type="button" class="snippet-dialog-cancel">Cancel</button>
      <button type="submit" value="save" class="app-dialog-primary">Save</button>
    </div>
  </form>
`;
document.body.appendChild(saveSnippetDialog);
enableClickOutsideToClose(saveSnippetDialog);
const snippetNameInput = saveSnippetDialog.querySelector('#snippet-dialog-name');
const snippetCategorySelect = saveSnippetDialog.querySelector('#snippet-dialog-category');
const snippetNewCategoryInput = saveSnippetDialog.querySelector('#snippet-dialog-new-category');
saveSnippetDialog.querySelector('.snippet-dialog-cancel').addEventListener('click', () => saveSnippetDialog.close('cancel'));

// An ordinary <input list=...> would let you type a brand-new category inline, but the native
// suggestions popup that comes with it can't be restyled - in Chrome it renders like a stray
// speech bubble that looks nothing like the rest of the app. A plain themed <select> matches the
// Manage Snippets category filter exactly; this sentinel option (vanishingly unlikely to collide
// with a real category name) reveals a plain text input for typing a new one instead.
const NEW_CATEGORY_OPTION_VALUE = '\u0000__new_category__';
snippetCategorySelect.addEventListener('change', () => {
  const isNew = snippetCategorySelect.value === NEW_CATEGORY_OPTION_VALUE;
  snippetNewCategoryInput.hidden = !isNew;
  if (isNew) {
    snippetNewCategoryInput.value = '';
    snippetNewCategoryInput.focus();
  }
});

let snippetLatexToSave = null;
saveSnippetDialog.addEventListener('close', () => {
  if (saveSnippetDialog.returnValue !== 'save') return;
  const name = snippetNameInput.value.trim();
  if (!name || !snippetLatexToSave) return;
  const category =
    snippetCategorySelect.value === NEW_CATEGORY_OPTION_VALUE ? snippetNewCategoryInput.value.trim() : snippetCategorySelect.value;
  saveSnippets([...loadSnippets(), createSnippet(name, snippetLatexToSave, category)]);
  showStatus(`Saved "${name}" as a snippet.`, false);
});

function openSaveSnippetDialog(latex) {
  if (!latex || !latex.trim()) {
    showStatus('Nothing to save - select something, or make sure the field has content.', true);
    return;
  }
  snippetLatexToSave = latex;
  saveSnippetDialog.returnValue = '';
  snippetNameInput.value = '';
  snippetNewCategoryInput.hidden = true;
  snippetNewCategoryInput.value = '';
  snippetCategorySelect.replaceChildren(
    makeOption('', 'No category'),
    ...distinctCategories(loadSnippets()).map((category) => makeOption(category, category)),
    makeOption(NEW_CATEGORY_OPTION_VALUE, '+ New category\u2026')
  );
  saveSnippetDialog.showModal();
  snippetNameInput.focus();
}

// Builds one {label, description, onActivate} entry that inserts the given snippet into `field`.
function buildInsertSnippetItem(snippet, field) {
  return {
    label: snippet.name,
    description: snippet.latex,
    onActivate: () => {
      activeMathField = field;
      field.insert(snippet.latex, { format: 'latex' });
      // Same MathLive quirk rebuildMathField works around for the showModal()-triggered case
      // (see its own comment, and the bigger one near the end of this file) - insert() leaves
      // the field unable to accept further physical keystrokes (navigating and deleting still
      // work). Unlike the window blur/refocus variant fieldToRecoverOnRefocus handles, simply
      // cycling focus away and back didn't reliably fix this one (confirmed by hand) - this is
      // a known, longstanding MathLive/Chromium issue where that trick is reported to work only
      // intermittently (https://github.com/arnog/mathlive/issues/2588). Replacing the field
      // with a fresh instance is the one fix already proven reliable elsewhere in this file.
      const line = field.closest('.doc-line');
      if (line) rebuildMathField(line);
    },
  };
}

// Builds the "Insert snippet" submenu's items for the current field - always available (like
// Insert Matrix/Insert Template), since inserting one doesn't depend on anything being selected.
// Flat when every snippet shares one category (or none do); otherwise nested one level into a
// submenu per category, alphabetically with Uncategorised last, reusing the same submenu
// mechanism Differentiate/Integrate/Solve already use for their variable-picking submenus.
function buildInsertSnippetItems(field) {
  const snippets = loadSnippets();
  if (snippets.length === 0) return [{ heading: 'No snippets saved yet' }];

  const categories = distinctCategories(snippets);
  const hasUncategorised = snippets.some((s) => !(s.category || '').trim());
  if (categories.length + (hasUncategorised ? 1 : 0) <= 1) {
    return snippets.map((snippet) => buildInsertSnippetItem(snippet, field));
  }

  const groups = new Map();
  for (const snippet of snippets) {
    const label = categoryLabel(snippet);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(snippet);
  }
  const sortedLabels = [...groups.keys()].sort((a, b) => {
    if (a === UNCATEGORISED_LABEL) return 1;
    if (b === UNCATEGORISED_LABEL) return -1;
    return a.localeCompare(b);
  });
  return sortedLabels.map((label) => ({
    label,
    submenu: groups.get(label).map((snippet) => buildInsertSnippetItem(snippet, field)),
  }));
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
      opId: op.id,
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
      opId: op.id,
      onActivate: () => {
        activeMathField = field;
        runOperation((latex) => op.compute(latex, variable));
      },
    };
  }

  return {
    label: op.label,
    description: op.description,
    opId: op.id,
    onActivate: () => {
      activeMathField = field;
      runOperation(op.compute);
    },
  };
}

// Builds and shows the field's whole right-click menu: Morph operations for the current
// selection (if any), clipboard actions, export, and the always-available insert/mode tools.
function openFieldMenu(field, x, y) {
  const native = nativeMenuDataByField.get(field);
  const selectionLatex = selectionLatexFor(field);

  fieldMenu.innerHTML = '';

  if (selectionLatex) {
    const unknowns = freeVariablesOf(selectionLatex);

    const topLevelItems = operations
      .filter((op) => MORPH_TOP_LEVEL_IDS.includes(op.id))
      .map((op) => buildOperationMenuItem(op, unknowns, field));
    const categoryItems = MORPH_CATEGORIES.map((category) => {
      const items = operations.filter((op) => category.groups.includes(op.group) && !MORPH_TOP_LEVEL_IDS.includes(op.id));
      return { label: category.label, submenu: items.map((op) => buildOperationMenuItem(op, unknowns, field)) };
    });
    addSubmenu(
      fieldMenu,
      'Morph',
      [...topLevelItems, { divider: true }, ...categoryItems],
      undefined,
      MENU_ICON_MORPH,
    );
    addMenuDivider(fieldMenu);

    // By this point there's always a selection - either the user's own, or the whole-field
    // auto-selection the contextmenu/menuBtn handlers fall back to above - so Cut always has
    // something to act on.
    addMenuButton(fieldMenu, 'Cut', () => native.cut?.onMenuSelect(), undefined, MENU_ICON_CUT);
  }

  // MathLive's own Copy/Copy special commands act on whatever is currently selected - with
  // nothing selected that would silently copy nothing, which is why these used to be hidden
  // entirely in that case. Falling back to the whole field instead (like Export already does
  // below) is far more useful: temporarily select everything so those commands have something
  // to act on, then restore the original cursor position afterwards.
  addMenuButton(
    fieldMenu,
    'Copy',
    () => withWholeFieldSelectionIfNeeded(field, Boolean(selectionLatex), () => field.executeCommand('copyToClipboard')),
    undefined,
    MENU_ICON_COPY,
  );
  addSubmenu(
    fieldMenu,
    'Copy special',
    native.copyFormats.map((format) => {
      const label = resolveLabel(format);
      return {
        label,
        onActivate: () =>
          withWholeFieldSelectionIfNeeded(field, Boolean(selectionLatex), () => {
            format.onMenuSelect();
            if (label === 'Copy as LaTeX') trackGoatCounterEvent('Mathamorph - LaTeX exported');
          }),
      };
    }),
    undefined,
    MENU_ICON_COPY,
  );
  addMenuDivider(fieldMenu);

  const exportItem = buildExportMenu(field);
  for (const exp of exportItem.submenu) addMenuButton(fieldMenu, exp.label, () => exp.onMenuSelect(), undefined, exp.icon);
  addMenuDivider(fieldMenu);

  addMenuButton(fieldMenu, 'Paste', () => native.paste?.onMenuSelect(), undefined, MENU_ICON_PASTE);
  addMenuDivider(fieldMenu);

  addSubmenu(
    fieldMenu,
    'Insert',
    [
      { widget: (ul) => addMatrixPicker(ul, field, native.insertMatrix) },
      { divider: true },
      ...native.insertTemplates.map((item) =>
        item.type === 'heading'
          ? { heading: resolveLabel(item) }
          : { label: resolveLabel(item), html: true, onActivate: () => item.onMenuSelect() },
      ),
    ],
    undefined,
    MENU_ICON_PLUS,
  );
  addMenuDivider(fieldMenu);

  addSubmenu(fieldMenu, 'Insert snippet', buildInsertSnippetItems(field), undefined, MENU_ICON_FOLDER);
  addMenuButton(
    fieldMenu,
    'Save as snippet\u2026',
    () => openSaveSnippetDialog(selectionLatex || field.value),
    'Save the selection (or the whole field, if nothing is selected) as a reusable named snippet.',
    MENU_ICON_SAVE,
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
    undefined,
    MENU_ICON_MODE,
  );

  fieldMenu.hidden = false;
  // Clamp position so the menu doesn't spill off the right/bottom edge of the viewport - shared
  // with the submenu toggles below, since expanding one can change the menu's height just as
  // much as it varies by selection here.
  fieldMenu.style.left = `${x}px`;
  fieldMenu.style.top = `${y}px`;
  clampFieldMenuToViewport();
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
// to embed), so exports stay crisp at any zoom - unlike MathLive's own rendering, which is just
// painted pixels by the time anything outside the page tries to capture it.
let mathJaxReadyPromise = null;
function loadMathJax() {
  if (!mathJaxReadyPromise) {
    mathJaxReadyPromise = new Promise((resolve, reject) => {
      // fontCache 'local' bakes each glyph's path data into every SVG, so each one is fully
      // self-contained rather than relying on a shared global cache.
      window.MathJax = { svg: { fontCache: 'local' }, startup: { typeset: false } };
      const script = document.createElement('script');
      // Pinned to an exact version for the same reason as the mathlive/compute-engine imports
      // above - see sw.js for the matching cached URL.
      script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js';
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
  if (g) g.setAttribute('fill', 'black');

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
  const latexForExport = selectionLatexFor(field) || field.value;

  const items = [
    {
      label: 'Copy as PNG',
      icon: MENU_ICON_IMAGE,
      onMenuSelect: async () => {
        const latex = latexForExport;
        if (!latex || !latex.trim()) {
          showStatus('Nothing to export.', true);
          return;
        }
        try {
          const blob = await latexToPngBlob(latex);
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          showStatus('Copied as an image.', false);
          trackGoatCounterEvent('Mathamorph - PNG exported');
        } catch (err) {
          console.error(err);
          showStatus('Could not copy as an image.', true);
        }
      },
    },
    {
      label: 'Download as SVG',
      icon: MENU_ICON_DOWNLOAD,
      onMenuSelect: async () => {
        const latex = latexForExport;
        if (!latex || !latex.trim()) {
          showStatus('Nothing to export.', true);
          return;
        }
        try {
          const { svg } = await latexToSvg(latex);
          downloadFile('mathamorph.svg', serializeSvg(svg), 'image/svg+xml');
          showStatus('Downloaded as SVG.', false);
          trackGoatCounterEvent('Mathamorph - SVG exported');
        } catch (err) {
          console.error(err);
          showStatus('Could not export as SVG.', true);
        }
      },
    },
  ];

  // Only offered when the exportable LaTeX (selection, or the whole field) is actually a
  // plottable equation - see graphitiModeFor for exactly what that means.
  const graphitiMode = graphitiModeFor(latexForExport);
  if (graphitiMode) {
    // Kick the (tiny) LZString load off now, while the menu is open, so it's normally already
    // resolved by the time this item is actually clicked - see below for why that matters.
    loadLZString().catch(() => {});
    items.push({
      label: 'Open in Graphiti\u2026',
      icon: GRAPHITI_MENU_ICON,
      onMenuSelect: () => {
        const latex = latexForExport;
        // The tab has to be opened synchronously, right from this click, or most browsers'
        // popup blockers silently swallow it - awaiting LZString first and only then calling
        // window.open() would be too late. Opening it blank now and navigating it once the
        // compressed state is ready keeps the gesture synchronous either way.
        const graphitiTab = window.open('', '_blank');
        if (!graphitiTab) {
          showStatus('Please allow pop-ups to open in Graphiti.', true);
          return;
        }
        graphitiTab.opener = null;
        // See fieldToRecoverOnRefocus's own comment (near scratchField, at the top of this
        // file) for why this field specifically needs recovering once the user comes back.
        fieldToRecoverOnRefocus = field;
        loadLZString()
          .then((LZString) => {
            graphitiTab.location.href = buildGraphitiUrl(LZString, latex, graphitiMode);
            trackGoatCounterEvent('Mathamorph - opened in Graphiti');
          })
          .catch((err) => {
            console.error(err);
            graphitiTab.close();
            showStatus('Could not open in Graphiti.', true);
          });
      },
    });
  }

  // Only offered when the exportable LaTeX (selection, or the whole field) is a genuine
  // single-variable equation - see isKomplexitiEquation for exactly what that means.
  if (isKomplexitiEquation(latexForExport)) {
    // Kick the (tiny) LZString load off now, while the menu is open, so it's normally already
    // resolved by the time this item is actually clicked - see below for why that matters.
    loadLZString().catch(() => {});
    items.push({
      label: 'Open in Komplexiti\u2026',
      icon: KOMPLEXITI_MENU_ICON,
      onMenuSelect: () => {
        const latex = latexForExport;
        // The tab has to be opened synchronously, right from this click, or most browsers'
        // popup blockers silently swallow it - awaiting LZString first and only then calling
        // window.open() would be too late. Opening it blank now and navigating it once the
        // compressed state is ready keeps the gesture synchronous either way.
        const komplexitiTab = window.open('', '_blank');
        if (!komplexitiTab) {
          showStatus('Please allow pop-ups to open in Komplexiti.', true);
          return;
        }
        komplexitiTab.opener = null;
        // See fieldToRecoverOnRefocus's own comment (near scratchField, at the top of this
        // file) for why this field specifically needs recovering once the user comes back.
        fieldToRecoverOnRefocus = field;
        loadLZString()
          .then((LZString) => {
            komplexitiTab.location.href = buildKomplexitiUrl(LZString, latex);
            trackGoatCounterEvent('Mathamorph - opened in Komplexiti');
          })
          .catch((err) => {
            console.error(err);
            komplexitiTab.close();
            showStatus('Could not open in Komplexiti.', true);
          });
      },
    });
  }

  return { label: 'Export', submenu: items };
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

const manageSnippetsBtn = document.getElementById('manage-snippets');
const exportSnippetsBtn = document.getElementById('export-snippets');
const importSnippetsBtn = document.getElementById('import-snippets');
const importSnippetsInput = document.getElementById('import-snippets-input');

const manageSnippetsDialog = document.createElement('dialog');
manageSnippetsDialog.className = 'app-dialog manage-snippets-dialog';
manageSnippetsDialog.innerHTML = `
  <h2>Manage snippets</h2>
  <div class="manage-snippets-filters">
    <input type="search" class="manage-snippets-search" placeholder="Search by name&hellip;" aria-label="Search snippets by name" />
      <select class="manage-snippets-category-filter themed-select" aria-label="Filter by category">
        <option value="">All categories</option>
      </select>
    </div>
    <div class="manage-snippets-list"></div>
  <div class="app-dialog-actions">
    <button type="button" class="manage-snippets-close">Close</button>
  </div>
`;
document.body.appendChild(manageSnippetsDialog);
enableClickOutsideToClose(manageSnippetsDialog);
const manageSnippetsList = manageSnippetsDialog.querySelector('.manage-snippets-list');
const manageSnippetsSearch = manageSnippetsDialog.querySelector('.manage-snippets-search');
const manageSnippetsCategoryFilter = manageSnippetsDialog.querySelector('.manage-snippets-category-filter');
manageSnippetsDialog.querySelector('.manage-snippets-close').addEventListener('click', () => manageSnippetsDialog.close());
manageSnippetsSearch.addEventListener('input', renderManageSnippetsList);
manageSnippetsCategoryFilter.addEventListener('change', renderManageSnippetsList);

function makeOption(value, label) {
  return Object.assign(document.createElement('option'), { value, textContent: label });
}

// A read-only math-field reuses MathLive's own rendering to show what a snippet actually
// contains, rather than asking the user to recognise it from its name alone.
function buildManageSnippetPreview(snippet) {
  const preview = document.createElement('math-field');
  preview.className = 'manage-snippet-preview';
  preview.setAttribute('read-only', '');
  preview.tabIndex = -1;
  // `read-only` and `tabindex="-1"` on the host alone still leave a focusable, contenteditable
  // region inside MathLive's own shadow DOM (confirmed: tabIndex 0, contenteditable="true") -
  // harmless on a desktop browser, but its small font size is exactly what was triggering a
  // residual iOS zoom when Manage Snippets opened, even once every ordinary form control in the
  // dialog was already a comfortable 16px. `inert` excludes the whole subtree - shadow DOM
  // included - from focus of any kind, which plain tabindex/read-only don't fully guarantee.
  preview.inert = true;
  preview.value = snippet.latex;
  return preview;
}

function buildManageSnippetRow(snippet, categories) {
  const row = document.createElement('div');
  row.className = 'manage-snippet-row';

  const fields = document.createElement('div');
  fields.className = 'manage-snippet-fields';

  const nameInput = document.createElement('input');
  nameInput.className = 'manage-snippet-name';
  nameInput.type = 'text';
  nameInput.setAttribute('aria-label', 'Snippet name');
  applyNoPasswordManagerAttrs(nameInput);
  nameInput.value = snippet.name;
  nameInput.addEventListener('change', () => {
    const current = loadSnippets();
    const target = current.find((s) => s.id === snippet.id);
    if (target) {
      target.name = nameInput.value.trim() || target.name;
      saveSnippets(current);
    }
    nameInput.value = target ? target.name : snippet.name;
  });

  // A themed <select> (identical to the category filter and the Save as snippet dialog's
  // category field) rather than an `<input list=...>` combo - the latter's native suggestions
  // popup can't be restyled and looks out of place next to everything else in the app. The
  // sentinel "+ New category…" option reveals a plain text input for typing a new one.
  const categorySelect = document.createElement('select');
  categorySelect.className = 'manage-snippet-category';
  categorySelect.setAttribute('aria-label', 'Snippet category');
  categorySelect.replaceChildren(
    makeOption('', 'No category'),
    ...categories.map((category) => makeOption(category, category)),
    makeOption(NEW_CATEGORY_OPTION_VALUE, '+ New category\u2026')
  );
  categorySelect.value = (snippet.category || '').trim();

  const newCategoryInput = document.createElement('input');
  newCategoryInput.type = 'text';
  newCategoryInput.className = 'manage-snippet-category';
  newCategoryInput.placeholder = 'New category name';
  newCategoryInput.hidden = true;
  newCategoryInput.setAttribute('aria-label', 'New category name');
  applyNoPasswordManagerAttrs(newCategoryInput);

  // Re-renders the whole list (not just this row) so moving a snippet to a different group, or
  // into/out of the last snippet of a now-empty category, is reflected in the grouping and
  // filter dropdown immediately.
  function saveCategory(category) {
    const current = loadSnippets();
    const target = current.find((s) => s.id === snippet.id);
    if (target) {
      target.category = category;
      saveSnippets(current);
    }
    renderManageSnippetsList();
  }

  categorySelect.addEventListener('change', () => {
    if (categorySelect.value === NEW_CATEGORY_OPTION_VALUE) {
      newCategoryInput.hidden = false;
      newCategoryInput.value = '';
      newCategoryInput.focus();
      return;
    }
    saveCategory(categorySelect.value);
  });

  newCategoryInput.addEventListener('change', () => saveCategory(newCategoryInput.value.trim()));

  fields.append(nameInput, categorySelect, newCategoryInput);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'manage-snippet-delete';
  deleteBtn.setAttribute('aria-label', 'Delete snippet');
  deleteBtn.innerHTML = DELETE_ICON_SVG;
  deleteBtn.addEventListener('click', () => {
    saveSnippets(loadSnippets().filter((s) => s.id !== snippet.id));
    renderManageSnippetsList();
  });

  row.append(buildManageSnippetPreview(snippet), fields, deleteBtn);
  return row;
}

// Rebuilt from scratch on every open, filter change, rename, recategorise or delete, rather than
// patched in place - the list is short enough that this is simpler than tracking per-row state.
function renderManageSnippetsList() {
  const snippets = loadSnippets();

  // The category filter's own options are rebuilt every render (not just on open) so renaming a
  // snippet into a brand-new category makes that category immediately choosable, and a category
  // that's just been emptied out disappears again on its own - nothing to separately maintain.
  // 'Uncategorised' only appears once something actually needs it, same as any other category.
  const categories = distinctCategories(snippets);
  const hasUncategorised = snippets.some((s) => !(s.category || '').trim());
  const previousFilter = manageSnippetsCategoryFilter.value;
  manageSnippetsCategoryFilter.replaceChildren(
    makeOption('', 'All categories'),
    ...categories.map((category) => makeOption(category, category)),
    ...(hasUncategorised ? [makeOption(UNCATEGORISED_LABEL, UNCATEGORISED_LABEL)] : [])
  );
  manageSnippetsCategoryFilter.value = [...manageSnippetsCategoryFilter.options].some((o) => o.value === previousFilter)
    ? previousFilter
    : '';

  manageSnippetsList.innerHTML = '';

  if (snippets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'manage-snippets-empty';
    empty.textContent = 'No snippets saved yet - right-click any field and choose "Save as snippet" to add one.';
    manageSnippetsList.appendChild(empty);
    return;
  }

  const search = manageSnippetsSearch.value.trim().toLowerCase();
  const categoryFilter = manageSnippetsCategoryFilter.value;
  const filtered = snippets.filter((snippet) => {
    const matchesSearch = !search || snippet.name.toLowerCase().includes(search) || categoryLabel(snippet).toLowerCase().includes(search);
    const matchesCategory = !categoryFilter || categoryLabel(snippet) === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'manage-snippets-empty';
    empty.textContent = 'No snippets match your search.';
    manageSnippetsList.appendChild(empty);
    return;
  }

  // Grouped by category, alphabetically, with Uncategorised always last - keeps related
  // snippets together even in a long library, mirroring the context menu's own
  // heading-above-a-group convention for the equivalent Insert Snippet submenu.
  const groups = new Map();
  for (const snippet of filtered) {
    const label = categoryLabel(snippet);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(snippet);
  }
  const sortedLabels = [...groups.keys()].sort((a, b) => {
    if (a === UNCATEGORISED_LABEL) return 1;
    if (b === UNCATEGORISED_LABEL) return -1;
    return a.localeCompare(b);
  });

  for (const label of sortedLabels) {
    // Only worth a heading once there's more than one group - a library that's entirely one
    // category (or entirely uncategorised) gains nothing from a heading repeating the obvious.
    if (sortedLabels.length > 1) {
      const heading = document.createElement('h3');
      heading.className = 'manage-snippets-group-heading';
      heading.textContent = label;
      manageSnippetsList.appendChild(heading);
    }
    for (const snippet of groups.get(label)) {
      manageSnippetsList.appendChild(buildManageSnippetRow(snippet, categories));
    }
  }
}

manageSnippetsBtn.addEventListener('click', () => {
  renderManageSnippetsList();
  manageSnippetsDialog.showModal();
  closeHeaderMenu();
});

exportSnippetsBtn.addEventListener('click', () => {
  const snippets = loadSnippets();
  if (snippets.length === 0) {
    showStatus('No snippets to export yet.', true);
  } else {
    downloadFile('mathamorph-snippets.json', JSON.stringify(snippets, null, 2), 'application/json');
    showStatus(`Exported ${snippets.length} snippet${snippets.length === 1 ? '' : 's'}.`, false);
  }
  closeHeaderMenu();
});

importSnippetsBtn.addEventListener('click', () => {
  importSnippetsInput.click();
  closeHeaderMenu();
});

importSnippetsInput.addEventListener('change', () => {
  const file = importSnippetsInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let imported;
    try {
      imported = JSON.parse(reader.result);
    } catch (err) {
      console.error(err);
      showStatus('That file is not a valid snippet library.', true);
      return;
    }
    if (!Array.isArray(imported)) {
      showStatus('That file is not a valid snippet library.', true);
      return;
    }
    // Always additive, never destructive - re-id every imported snippet so it can't collide
    // with (or silently overwrite) one already in the library that happens to reuse the same id.
    const newOnes = imported
      .filter((entry) => entry && typeof entry.latex === 'string' && typeof entry.name === 'string')
      .map((entry) =>
        createSnippet(
          entry.name,
          entry.latex,
          typeof entry.category === 'string' ? entry.category.trim() : '',
          Array.isArray(entry.tags) ? entry.tags : []
        )
      );
    saveSnippets([...loadSnippets(), ...newOnes]);
    showStatus(`Imported ${newOnes.length} snippet${newOnes.length === 1 ? '' : 's'}.`, false);
  };
  reader.onerror = () => showStatus('Could not read that file.', true);
  reader.readAsText(file);
  importSnippetsInput.value = '';
});

const showAboutBtn = document.getElementById('show-about');
const ABOUT_STARTUP_STORAGE_KEY = 'mathamorph-show-about-on-startup';

// Defaults to showing it - a brand-new user has never seen it, so there's nothing to opt out of.
function shouldShowAboutOnStartup() {
  const raw = localStorage.getItem(ABOUT_STARTUP_STORAGE_KEY);
  return raw === null ? true : raw === 'true';
}

const aboutDialog = document.createElement('dialog');
aboutDialog.className = 'app-dialog about-dialog';
aboutDialog.innerHTML = `
  <div class="about-header">
    <img src="images/logo.svg" alt="" class="about-logo" />
    <h2><span class="t-math">Math</span><span class="t-link">a</span><span class="t-morph">morph</span></h2>
  </div>
  <p class="about-description">
    Mathamorph lets you create and transform equations ready to drop into any document, slide, or
    app. Type maths as easily as text, then <strong class="hint-morph"><em>morph</em></strong> it: simplify, solve, factorise, expand,
    integrate, differentiate, or find eigenvalues, all with a quick highlight and click.
  </p>
  <p class="about-description">
    Export clean results as <strong>PNG, SVG, or LaTeX</strong>, making it effortless to build
    worksheets and presentations in less time. Mathamorph turns equation building into a creative,
    time-saving flow for teachers and creators who need results fast.
  </p>
  <p class="about-description">
    Equations in x/y or r/&theta; can also be sent straight to
    <a href="https://www.korovatron.co.uk/graphiti/" target="_blank" rel="noopener noreferrer">Graphiti</a>,
    our companion graphing calculator, for plotting.
  </p>
  <p class="about-description">
    Single-variable equations in a complex variable can be sent straight to
    <a href="https://www.korovatron.co.uk/komplexiti/" target="_blank" rel="noopener noreferrer">Komplexiti</a>,
    our companion Argand diagram plotter, for visualising.
  </p>
  <p class="about-description">
    Sign in with Google (from the menu) to sync your snippet library across your devices.
  </p>
  <p class="about-copyright">&copy; 2026 Neil Kendall</p>
  <p class="about-link">
    <a href="https://www.korovatron.co.uk" target="_blank" rel="noopener noreferrer">More maths tools @ www.korovatron.co.uk</a>
  </p>
  <label class="about-startup-check">
    <input type="checkbox" id="about-show-startup" />
    Show this on startup
  </label>
  <div class="app-dialog-actions">
    <button type="button" class="about-dialog-close app-dialog-primary">Close</button>
  </div>
`;
document.body.appendChild(aboutDialog);
enableClickOutsideToClose(aboutDialog);
const aboutShowStartupCheckbox = aboutDialog.querySelector('#about-show-startup');
aboutShowStartupCheckbox.addEventListener('change', () => {
  localStorage.setItem(ABOUT_STARTUP_STORAGE_KEY, String(aboutShowStartupCheckbox.checked));
});
const aboutCloseBtn = aboutDialog.querySelector('.about-dialog-close');
aboutCloseBtn.addEventListener('click', () => aboutDialog.close());

function openAboutDialog() {
  aboutShowStartupCheckbox.checked = shouldShowAboutOnStartup();
  aboutDialog.showModal();
  // Without an explicit focus target, the browser defaults to focusing the first focusable
  // element inside the dialog - here that's the "More maths tools" link, which then shows a
  // jarring focus ring on open for no real reason. Close is a safer, more expected default.
  aboutCloseBtn.focus();
}

showAboutBtn.addEventListener('click', () => {
  openAboutDialog();
  closeHeaderMenu();
});

// Reference for each shortcut: [what to type/press, what it does]. Verified directly against
// MathLive's actual behaviour rather than assumed, since a wrong shortcut here is worse than none.
const HELP_SHORTCUTS = [
  { keys: '/', description: 'Turns what you just typed into a fraction (e.g. type 1/2).' },
  { keys: 'sqrt', description: 'Square root.' },
  { keys: '^', description: 'Superscript (power).' },
  { keys: '_', description: 'Subscript.' },
  { keys: 'pi, theta, alpha, ...', description: 'Greek letters - type the name.' },
  { keys: 'infty', description: 'Infinity symbol (\u221e).' },
  { keys: 'sum, int', description: 'Summation (\u2211) or integral (\u222b), with placeholders for the bounds.' },
  { keys: '&gt;=, &lt;=, !=', description: 'Turns into \u2265, \u2264, \u2260.' },
  {
    keys: '+-',
    description: 'Turns into \u00b1 (plus/minus). The + and - numpad keys work too, in either combination.',
  },
  { keys: '-=', description: 'Turns into \u2261 (is identical to).' },
  { keys: '(', description: 'Automatically adds the matching closing bracket.' },
  { keys: 'Tab / Shift+Tab', description: 'Jump to the next/previous placeholder.' },
  {
    keys: 'Esc, then e.g. \\equiv, then Enter',
    description: 'Type a LaTeX command directly, for any symbol that doesn\u2019t have its own shortcut above.',
  },
];

const helpDialog = document.createElement('dialog');
helpDialog.className = 'app-dialog help-dialog';
helpDialog.innerHTML = `
  <h2>Shortcuts</h2>
  <ul class="help-shortcuts">
    ${HELP_SHORTCUTS.map((s) => `<li><code>${s.keys}</code><span>${s.description}</span></li>`).join('')}
  </ul>
  <p class="help-dialog-link">
    See the full
    <a href="https://mathlive.io/mathfield/reference/keybindings/#inline-shortcuts" target="_blank" rel="noopener noreferrer">list of keyboard shortcuts</a>
    for more.
  </p>
  <div class="app-dialog-actions">
    <button type="button" class="help-dialog-close app-dialog-primary">Close</button>
  </div>
`;
document.body.appendChild(helpDialog);
enableClickOutsideToClose(helpDialog);
const helpCloseBtn = helpDialog.querySelector('.help-dialog-close');
helpCloseBtn.addEventListener('click', () => helpDialog.close());

const showHelpBtn = document.getElementById('show-help');
showHelpBtn.addEventListener('click', () => {
  helpDialog.showModal();
  helpCloseBtn.focus();
  closeHeaderMenu();
});

// The in-app menu opens this scrollable dialog, whose content is kept identical to the
// standalone policies/privacy_policy.html page. That separate static page is kept around (and
// is NOT replaced by this dialog) because it needs to stay reachable as an actual URL, as
// required for the Privacy Policy link on Google's OAuth consent screen - a dialog's content
// isn't addressable by its own URL.
const privacyDialog = document.createElement('dialog');
privacyDialog.className = 'app-dialog privacy-dialog';
privacyDialog.innerHTML = `
  <div class="privacy-dialog-body">
    <h2>Privacy Policy for Mathamorph</h2>
    <p class="privacy-effective-date"><strong>Effective date:</strong> 5 October 2026</p>

    <p>
      This policy covers the Mathamorph app specifically. It sits alongside, and is the
      documented exception to, the main
      <a href="https://www.korovatron.co.uk/privacy-policy.html" target="_blank" rel="noopener noreferrer">Korovatron privacy policy</a>,
      which covers the rest of korovatron.co.uk.
    </p>

    <h3>What We Collect</h3>
    <p>
      By default, Mathamorph collects nothing. Your equations and saved snippets are stored only
      in your browser's local storage on your own device, and the app works fully offline.
    </p>
    <p>
      Google account data collection is optional and only applies if you choose to sign in with
      Google (from the app's menu) to sync your snippet library across your own devices. When you
      sign in using Google OAuth, we receive:
    </p>
    <ul>
      <li>Your email address</li>
      <li>Your Google display name</li>
    </ul>
    <p>
      This data, together with your synced snippet library, is stored in a private, per-account
      Google Firestore database (hosted in the EU) that only your account can read or write.
    </p>

    <h3>Why We Store It</h3>
    <p>The purposes below apply only when you choose optional Google sign-in:</p>
    <ul>
      <li>Sync your snippet library across the devices you use to access Mathamorph</li>
      <li>Identify your account if you request data deletion or support</li>
    </ul>
    <p>We do not use your personal data for marketing, profiling, or advertising.</p>

    <h3>Analytics</h3>
    <p>
      We use a privacy-focused analytics tool to measure aggregate website traffic, such as page
      views, visit counts, and high-level browser/device statistics.
    </p>
    <p>
      <strong>GoatCounter</strong> is an open-source, privacy-friendly analytics service. It
      records page views and basic visit data (such as browser type and country) without using
      cookies or tracking individuals across sites. GoatCounter's privacy policy is available at
      <a href="https://www.goatcounter.com/help/privacy" target="_blank" rel="noopener noreferrer">goatcounter.com/help/privacy</a>.
    </p>
    <p>We do not track what equations or snippets you type, create, or save.</p>

    <h3>Authentication</h3>
    <p>
      Mathamorph offers optional Google Sign-In for cross-device snippet sync. You can use the
      app fully without signing in. If you choose to sign in, we do not collect or store
      passwords - your login credentials are managed securely by Google. Signing out at any time
      stops further syncing; your local work on that device is unaffected either way.
    </p>

    <h3>What We Don't Do</h3>
    <p>We do not:</p>
    <ul>
      <li>Sell your personal data</li>
      <li>Share your personal data with anyone else</li>
      <li>Display your personal information publicly to other users</li>
      <li>Use advertising or cross-site tracking cookies</li>
      <li>Use analytics to profile you through individual equations or snippets</li>
    </ul>
    <p>
      We do use trusted service providers: Google/Firebase (for optional sign-in and cloud sync)
      and GoatCounter (for open-source, cookie-free page view analytics).
    </p>

    <h3>Data Deletion</h3>
    <p>
      You can request deletion of your account and any synced snippet data at any time. Just
      email us at <a href="mailto:unimatrix@korovatron.co.uk">unimatrix@korovatron.co.uk</a>, and
      we'll verify your identity using your Google account details before proceeding.
    </p>

    <h3>Security</h3>
    <p>
      If you choose optional Google Sign-In/cloud sync, your account and synced snippet data are
      stored in Google Firestore, a secure cloud-hosted NoSQL database. We follow best practices
      to protect your information, but no system is 100% foolproof. We rely on Google's robust
      infrastructure and encourage you to sign out when you're done on a shared device.
    </p>

    <h3>Contact Us</h3>
    <p>Questions? Concerns? Want your data deleted? Reach out at:</p>
    <p>Email: <a href="mailto:unimatrix@korovatron.co.uk">unimatrix@korovatron.co.uk</a></p>

    <p class="privacy-footer-note">Mathamorph is published by Korovatron (Neil Kendall).</p>
  </div>
  <div class="app-dialog-actions">
    <button type="button" class="privacy-dialog-close app-dialog-primary">Close</button>
  </div>
`;
document.body.appendChild(privacyDialog);
enableClickOutsideToClose(privacyDialog);
const privacyCloseBtn = privacyDialog.querySelector('.privacy-dialog-close');
privacyCloseBtn.addEventListener('click', () => privacyDialog.close());

const showPrivacyBtn = document.getElementById('show-privacy');
showPrivacyBtn.addEventListener('click', () => {
  privacyDialog.showModal();
  privacyCloseBtn.focus();
  closeHeaderMenu();
});

// "Board mode" (see the board-mode-btn on each line, above) makes the most of the viewport to
// show one equation as large as possible without clipping, for displaying to a class on a
// projector or whiteboard. A single shared read-only math-field is reused across every line
// (like the snippet previews in Manage snippets) rather than cloning each field's own element.
const boardDialog = document.createElement('dialog');
boardDialog.className = 'app-dialog board-dialog';
boardDialog.innerHTML = `
  <button type="button" class="board-dialog-close" aria-label="Close board mode">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  </button>
  <div class="board-content">
    <math-field read-only tabindex="-1"></math-field>
  </div>
`;
document.body.appendChild(boardDialog);
enableClickOutsideToClose(boardDialog);
const boardField = boardDialog.querySelector('math-field');
const boardContent = boardDialog.querySelector('.board-content');
boardDialog.querySelector('.board-dialog-close').addEventListener('click', () => boardDialog.close());

// Scales boardField's font-size so the equation fills as much of the available space as
// possible without clipping, preserving its aspect ratio. MathLive renders in em units relative
// to the field's own font-size, so this is a measure-at-a-known-size-then-scale approach: render
// at an arbitrary baseline, measure how big that actually came out, then scale by whatever factor
// makes it exactly fill the content area's width or height (whichever is the binding constraint).
function fitBoardField() {
  const BASELINE_FONT_SIZE = 32;
  boardField.style.fontSize = `${BASELINE_FONT_SIZE}px`;
  const contentRect = boardContent.getBoundingClientRect();
  const fieldRect = boardField.getBoundingClientRect();
  if (fieldRect.width === 0 || fieldRect.height === 0) return;
  const scale = Math.min(contentRect.width / fieldRect.width, contentRect.height / fieldRect.height);
  boardField.style.fontSize = `${BASELINE_FONT_SIZE * scale}px`;
}

let boardResizeObserver = null;
let boardSourceField = null;

function openBoardMode(field) {
  const latex = field.value;
  if (!latex || !latex.trim()) {
    showStatus('Nothing to display - the equation is empty.', true);
    return;
  }
  boardSourceField = field;
  boardField.value = latex;
  boardDialog.showModal();
  fitBoardField();
  // The dialog is meant to stay open on a projector for a while, so keep it filling the
  // viewport (and re-fit the equation to match) if the window/screen is resized while it's up.
  boardResizeObserver = new ResizeObserver(() => fitBoardField());
  boardResizeObserver.observe(boardContent);
}

boardDialog.addEventListener('close', () => {
  boardResizeObserver?.disconnect();
  boardResizeObserver = null;
  // Return attention to whichever field opened board mode, so the user can carry straight on
  // editing it instead of needing to click back into it first.
  boardSourceField?.focus();
  boardSourceField = null;
});

initializeDocument();
// A modal dialog's showModal() call permanently breaks physical-keystroke character insertion
// (navigation, deletion, and programmatic edits all keep working - only typing stops) in any
// math-field that exists at the time, if that field hasn't yet had a real keystroke typed into it
// since being created/having its value set programmatically (restoring the document always hits
// this - buildDocument() always sets .value directly rather than the user typing it in) - even
// long after the dialog is closed, even though document.activeElement and hasFocus() both look
// completely normal afterwards. This reproduces with any <dialog>.showModal(), isn't about focus
// timing, and no amount of delay before opening the dialog avoids it - only replacing the broken
// field with a fresh instance (see rebuildMathField()) does. The About dialog is the one place
// this can bite on a page that's otherwise untouched (freshly restored, never-yet-typed-into
// fields, with a dialog that opens automatically before the user has interacted with anything) -
// so once it's closed for the first time, every line still showing its original restored content
// gets its math-field rebuilt pre-emptively, before the user can run into the bug.
if (shouldShowAboutOnStartup()) {
  aboutDialog.addEventListener('close', () => {
    for (const line of allLines()) rebuildMathField(line);
  }, { once: true });
  openAboutDialog();
}

// Registers the offline/PWA service worker. Updates are applied quietly: once a new sw.js
// finishes installing alongside the one already controlling the page, tell it to take over
// immediately and reload once, rather than leaving the user on a stale cached version.
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          newWorker.postMessage({ type: 'SKIP_WAITING' });
          setTimeout(() => window.location.reload(), 1000);
        }
      });
    });
  } catch (err) {
    console.error('Service worker registration failed:', err);
  }
}
window.addEventListener('load', registerServiceWorker);
