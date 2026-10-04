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
  field.addEventListener('mount', () => {
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
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">' +
    '<line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';
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
// Tracked alongside the document itself purely so a signed-in device can tell, at sign-in time,
// whether its own local copy or the cloud's is more recent - see the document half of
// onAuthStateChanged further down.
const DOCUMENT_UPDATED_AT_STORAGE_KEY = 'mathamorph-document-updated-at';

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

// Auto-persists the live document to localStorage, so it survives reloads/browser restarts.
let persistTimeout = null;
function schedulePersist() {
  hideExamplesHint();
  clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(serializeDocument()));
    localStorage.setItem(DOCUMENT_UPDATED_AT_STORAGE_KEY, String(Date.now()));
    documentDirtyForCloud = true;
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

// `tags` isn't used by any UI yet, but is included from the start so that adding a
// filter/grouping feature later never needs a data migration - just a UI built on data that's
// already shaped for it.
function createSnippet(name, latex, tags = []) {
  return { id: createSnippetId(), name, latex, tags };
}

// --- Cloud sync (Google sign-in + Firestore) ---
// Snippets are opt-in-by-signing-in, not opt-in-by-a-separate-toggle: anyone who signs in
// obviously wants their library synced, so there's no extra "enable sync" step. Signed-out use
// is untouched - everything above this point already works entirely offline via localStorage,
// and that keeps working exactly as before for anyone who never signs in.
//
// The snippet library and the live document are both stored as fields in one Firestore document
// per user (users/{uid}.snippets / .document) rather than separate documents - every snippet
// mutation already funnels through saveSnippets() with the full array, and the live document
// through schedulePersist(), so this lets the sync layer hang off those two existing functions
// instead of diffing individual changes into separate writes. Every setDoc below passes
// { merge: true } so a snippets write can never clobber the document field or vice versa.
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

// Unlike snippets, the live document is only ever pulled from the cloud at startup/sign-in, never
// kept live via a realtime listener - this is a single-user scratchpad (a teacher picking up
// where they left off on another device), not a collaborative document, and buildDocument()
// replaces every field wholesale, which would steal focus and interrupt typing if it ever fired
// while someone was mid-edit. Pushes, on the other hand, happen continuously in the background -
// just infrequently (see DOCUMENT_CLOUD_PUSH_INTERVAL_MS), since a stale-by-a-few-seconds cloud
// copy doesn't matter but a Firestore write on every keystroke would.
const DOCUMENT_CLOUD_PUSH_INTERVAL_MS = 30000;
let documentDirtyForCloud = false;

function pushDocumentToCloud() {
  if (!currentUser) return;
  documentDirtyForCloud = false;
  setDoc(
    doc(db, 'users', currentUser.uid),
    { document: serializeDocument(), documentUpdatedAt: serverTimestamp() },
    { merge: true }
  ).catch((err) => console.error(err));
}

setInterval(() => {
  if (documentDirtyForCloud) pushDocumentToCloud();
}, DOCUMENT_CLOUD_PUSH_INTERVAL_MS);

// Belt-and-braces flush for the common case of closing the tab/switching apps between one
// interval tick and the next - 'visibilitychange' (rather than 'beforeunload', which mobile
// browsers don't reliably fire) is the standard way to catch a "this might be the last moment
// this page is around" signal.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && documentDirtyForCloud) pushDocumentToCloud();
});

function updateAuthMenuUI() {
  authToggleLabel.textContent = currentUser ? 'Sign out' : 'Sign in to sync snippets';
  authToggleBtn.title = currentUser ? `Signed in as ${currentUser.email}` : '';
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
      // rather than starting from an empty library/document.
      await setDoc(userDocRef, {
        snippets: loadSnippets(),
        snippetsUpdatedAt: serverTimestamp(),
        document: serializeDocument(),
        documentUpdatedAt: serverTimestamp(),
      });
    } else {
      const data = snap.data();

      // Signing in on a device that already has local snippets the cloud doesn't know about yet
      // (e.g. first sign-in on a second device): merge rather than silently discarding either
      // side - union by id, then push the merged result back up.
      const cloudSnippets = Array.isArray(data.snippets) ? data.snippets : [];
      const cloudIds = new Set(cloudSnippets.map((s) => s.id));
      const localOnly = loadSnippets().filter((s) => !cloudIds.has(s.id));
      const mergedSnippets = [...cloudSnippets, ...localOnly];
      applyIncomingSnippets(mergedSnippets);
      if (localOnly.length > 0) {
        await setDoc(userDocRef, { snippets: mergedSnippets, snippetsUpdatedAt: serverTimestamp() }, { merge: true });
      }

      // The document isn't a set of discrete named items like snippets, so there's nothing
      // sensible to union - just whichever copy was edited more recently wins. A device that's
      // never locally saved a document (no DOCUMENT_UPDATED_AT_STORAGE_KEY yet - still just
      // showing the worked examples) always loses to a real cloud copy, if there is one.
      const cloudDocument = Array.isArray(data.document) ? data.document : null;
      const cloudUpdatedAtMs = data.documentUpdatedAt?.toMillis?.() ?? 0;
      const localUpdatedAtMs = Number(localStorage.getItem(DOCUMENT_UPDATED_AT_STORAGE_KEY)) || 0;
      if (cloudDocument && cloudUpdatedAtMs > localUpdatedAtMs) {
        if (JSON.stringify(cloudDocument) !== JSON.stringify(serializeDocument())) {
          buildDocument(cloudDocument);
          hideExamplesHint();
        }
        localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(cloudDocument));
        localStorage.setItem(DOCUMENT_UPDATED_AT_STORAGE_KEY, String(cloudUpdatedAtMs));
      } else if (localUpdatedAtMs > 0) {
        // Local is newer (or the cloud has nothing yet) - push now rather than waiting for the
        // next 30-second tick, so a second device signing in right after sees it already.
        pushDocumentToCloud();
      }
    }
  } catch (err) {
    console.error(err);
    showStatus('Could not load your synced snippets.', true);
  }

  // From here on, any snippet change made on *another* signed-in device arrives here live - no
  // manual "refresh" or re-opening the app needed. The document deliberately isn't included in
  // this listener - see the comment above DOCUMENT_CLOUD_PUSH_INTERVAL_MS.
  unsubscribeSnippetsListener = onSnapshot(
    userDocRef,
    (snap) => {
      if (!snap.exists()) return;
      applyIncomingSnippets(Array.isArray(snap.data().snippets) ? snap.data().snippets : []);
    },
    (err) => console.error(err)
  );
});

// A brand-new library is an empty, uninviting list with nothing to demonstrate the feature -
// seed it with a couple of common formulas on the very first run, so there's something useful
// (and something to learn the UI from) right away. Checked against the raw stored value, not
// just an empty array, so deliberately deleting every snippet later doesn't bring these back.
function seedDefaultSnippetsIfNeeded() {
  if (localStorage.getItem(SNIPPETS_STORAGE_KEY) !== null) return;
  saveSnippets([
    createSnippet('Quadratic formula', 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'),
    createSnippet('Trig identity: 1 + tan\u00b2\u03b8 = sec\u00b2\u03b8', '1+\\tan^2\\theta\\equiv\\sec^2\\theta'),
  ]);
}

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
    <div class="app-dialog-actions">
      <button type="button" class="snippet-dialog-cancel">Cancel</button>
      <button type="submit" value="save" class="app-dialog-primary">Save</button>
    </div>
  </form>
`;
document.body.appendChild(saveSnippetDialog);
enableClickOutsideToClose(saveSnippetDialog);
const snippetNameInput = saveSnippetDialog.querySelector('#snippet-dialog-name');
saveSnippetDialog.querySelector('.snippet-dialog-cancel').addEventListener('click', () => saveSnippetDialog.close('cancel'));

let snippetLatexToSave = null;
saveSnippetDialog.addEventListener('close', () => {
  if (saveSnippetDialog.returnValue !== 'save') return;
  const name = snippetNameInput.value.trim();
  if (!name || !snippetLatexToSave) return;
  saveSnippets([...loadSnippets(), createSnippet(name, snippetLatexToSave)]);
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
  saveSnippetDialog.showModal();
  snippetNameInput.focus();
}

// Builds the "Insert snippet" submenu's items for the current field - always available (like
// Insert Matrix/Insert Template), since inserting one doesn't depend on anything being selected.
function buildInsertSnippetItems(field) {
  const snippets = loadSnippets();
  if (snippets.length === 0) return [{ heading: 'No snippets saved yet' }];
  return snippets.map((snippet) => ({
    label: snippet.name,
    description: snippet.latex,
    onActivate: () => {
      activeMathField = field;
      field.insert(snippet.latex, { format: 'latex' });
    },
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
  <div class="manage-snippets-list"></div>
  <div class="app-dialog-actions">
    <button type="button" class="manage-snippets-close">Close</button>
  </div>
`;
document.body.appendChild(manageSnippetsDialog);
enableClickOutsideToClose(manageSnippetsDialog);
const manageSnippetsList = manageSnippetsDialog.querySelector('.manage-snippets-list');
manageSnippetsDialog.querySelector('.manage-snippets-close').addEventListener('click', () => manageSnippetsDialog.close());

// Rebuilt from scratch every time the modal opens (and after every rename/delete) rather than
// patched in place - the list is short enough that this is simpler than tracking per-row state.
function renderManageSnippetsList() {
  const snippets = loadSnippets();
  manageSnippetsList.innerHTML = '';

  if (snippets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'manage-snippets-empty';
    empty.textContent = 'No snippets saved yet - right-click any field and choose "Save as snippet" to add one.';
    manageSnippetsList.appendChild(empty);
    return;
  }

  for (const snippet of snippets) {
    const row = document.createElement('div');
    row.className = 'manage-snippet-row';

    // A read-only field reuses MathLive's own rendering to show what the snippet actually
    // contains, rather than asking the user to recognise it from its name alone.
    const preview = document.createElement('math-field');
    preview.className = 'manage-snippet-preview';
    preview.setAttribute('read-only', '');
    preview.tabIndex = -1;
    preview.value = snippet.latex;

    const nameInput = document.createElement('input');
    nameInput.className = 'manage-snippet-name';
    nameInput.type = 'text';
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

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'manage-snippet-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      saveSnippets(loadSnippets().filter((s) => s.id !== snippet.id));
      renderManageSnippetsList();
    });

    row.append(preview, nameInput, deleteBtn);
    manageSnippetsList.appendChild(row);
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
      .map((entry) => createSnippet(entry.name, entry.latex, Array.isArray(entry.tags) ? entry.tags : []));
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
    app. Type maths as easily as text, then <em>morph</em> it: simplify, solve, factorise, expand,
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

const privacyDialog = document.createElement('dialog');
privacyDialog.className = 'app-dialog privacy-dialog';
privacyDialog.innerHTML = `
  <h2>Privacy</h2>
  <p class="about-description">
    Mathamorph works entirely in your browser by default - your equations and saved snippets are
    stored only on this device, and the app works fully offline. Nothing is ever sent anywhere
    unless you choose to sign in.
  </p>
  <p class="about-description">
    Signing in with Google (from this menu) is entirely optional. It exists purely to sync your
    snippet library and current equations across your own devices, via Google Sign-In and a
    private, per-account database (Firestore, hosted in the EU) that only your account can read or
    write. It's never shared, sold, or used for anything else. Signing out at any time stops
    further syncing - your local work is unaffected either way.
  </p>
  <p class="about-description">
    Anonymous visit analytics (page views only - no cookies, no personal data) are collected via
    <a href="https://www.goatcounter.com" target="_blank" rel="noopener noreferrer">GoatCounter</a>
    to help us see how the app is used.
  </p>
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

seedDefaultSnippetsIfNeeded();
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
