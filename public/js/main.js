import { WordDictionary } from './dictionary.js';
import { CELLS } from './board.js';
import { BaldaGame, TIME_OPTIONS, DEFAULT_SETTINGS } from './game.js';

// Bumped whenever the shipped files change, so "which build am I running?" is
// answerable from the console instead of guessed at.
const BUILD = '7';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'balda.settings';

let game = null;
let clock = null;
let secondsLeft = null;
let thinking = false;

// --- boot ---------------------------------------------------------------

const now = () => (globalThis.performance?.now?.() ?? Date.now());

async function boot() {
  const t0 = now();
  const [words, s5, s3] = await Promise.all([
    fetch('words.txt').then((r) => r.text()),
    fetch('starters5.txt').then((r) => r.text()),
    fetch('starters3.txt').then((r) => r.text()),
  ]);
  const tFetched = now();
  const dict = new WordDictionary(words, s5, s3);
  const tParsed = now();

  // Readable in Safari Web Inspector when debugging the phone over USB.
  globalThis.console?.info?.(
    `Balda build ${BUILD}: ${dict.count} words — `
    + `fetch ${Math.round(tFetched - t0)} ms, parse ${Math.round(tParsed - tFetched)} ms`,
  );

  game = new BaldaGame(dict, loadSettings());
  buildBoard();
  buildLetterGrid();
  buildTimeOptions();
  wireControls();

  // Taken out of the document rather than just hidden: it's a fixed,
  // full-viewport layer, so if it ever stays in the tree it silently eats
  // every tap on the board and the buttons.
  $('loading')?.remove();
  $('app').hidden = false;
  showBuild();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/** Stamps the build number into the header, creating the element if the page
 *  came from an older cached index.html. Never assume the HTML matches the JS —
 *  a browser will happily pair a stale document with fresh scripts. */
function showBuild() {
  const h1 = document.querySelector('h1');
  if (!h1) return;
  let badge = document.getElementById('build');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'build';
    badge.className = 'build';
    h1.append(' ', badge);
  }
  badge.textContent = `build ${BUILD}`;
}

/** Last resort: put the failure on screen instead of leaving a blank page. */
function fatal(err) {
  const message = (err && err.message) ? err.message : String(err);
  globalThis.console?.error?.('Balda failed to start:', err);
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = `Balda build ${BUILD} failed to start — ${message}`;
  document.body?.append(box);
  const loading = document.getElementById('loading');
  if (loading) loading.remove();
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings));
  } catch { /* private browsing */ }
}

// --- board --------------------------------------------------------------

const cellEls = [];

function buildBoard() {
  const board = $('board');
  board.innerHTML = '';
  for (let i = 0; i < CELLS; i++) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.index = String(i);
    el.setAttribute('role', 'gridcell');
    board.appendChild(el);
    cellEls.push(el);
  }
  attachPointer(board);
}

/** Tap to step through a word, or drag across the letters in one stroke. */
function attachPointer(board) {
  let dragging = false;
  let moved = false;
  let lastIndex = -1;
  let startX = 0;
  let startY = 0;

  const indexAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.classList.contains('cell')) return -1;
    return Number(el.dataset.index);
  };

  board.addEventListener('pointerdown', (e) => {
    if (thinking || game.status !== 'playing') return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    lastIndex = indexAt(e.clientX, e.clientY);
    board.setPointerCapture(e.pointerId);
  });

  board.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 8) {
      moved = true;
      // The stroke began on a letter: seed the path with it.
      const g = game.workingGrid;
      if (lastIndex >= 0 && g[lastIndex] !== '') game.toggleInPath(lastIndex);
      render();
    }
    if (!moved) return;
    const i = indexAt(e.clientX, e.clientY);
    if (i < 0 || i === lastIndex) return;
    lastIndex = i;
    if (game.workingGrid[i] !== '') {
      game.toggleInPath(i);
      render();
    }
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    const i = indexAt(e.clientX, e.clientY);
    if (!moved && i >= 0) {
      game.highlightPath = [];
      if (game.workingGrid[i] !== '') {
        // Tapping the newly placed letter cycles select → deselect → remove.
        game.tapCell(i);
      } else if (game.canPlaceLetter(i)) {
        openLetterPicker(i);
      }
      render();
    }
    moved = false;
    lastIndex = -1;
  };

  board.addEventListener('pointerup', finish);
  board.addEventListener('pointercancel', () => { dragging = false; moved = false; });
}

// --- letter picker ------------------------------------------------------

let pickerCell = null;

function buildLetterGrid() {
  const grid = $('letterGrid');
  grid.innerHTML = '';
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = letter.toUpperCase();
    b.addEventListener('click', () => {
      if (pickerCell === null) return;
      game.placeLetter(letter, pickerCell);
      // Deliberately do NOT put the new cell into the path here. The word only
      // has to *pass through* the new letter — it may start anywhere and the
      // new letter may sit at the start, middle or end. Seeding the path forced
      // every word to begin with it.
      pickerCell = null;
      $('letterDialog').close();
      render();
    });
    grid.appendChild(b);
  }
}

function openLetterPicker(i) {
  pickerCell = i;
  $('letterDialog').showModal();
}

// --- settings -----------------------------------------------------------

function buildTimeOptions() {
  const sel = $('settingsForm').elements.turnSeconds;
  sel.innerHTML = '';
  for (const s of TIME_OPTIONS) {
    const o = document.createElement('option');
    o.value = s === null ? '' : String(s);
    o.textContent = s === null ? 'Unlimited' : (s < 60 ? `${s} sec` : `${s / 60} min`);
    sel.appendChild(o);
  }
}

function openSettings() {
  const f = $('settingsForm').elements;
  f.opponent.value = game.settings.opponent;
  f.difficulty.value = game.settings.difficulty;
  f.startMode.value = game.settings.startMode;
  f.turnSeconds.value = game.settings.turnSeconds === null ? '' : String(game.settings.turnSeconds);
  f.timeoutPolicy.value = game.settings.timeoutPolicy;
  syncSettingsVisibility();
  $('settingsDialog').showModal();
}

function syncSettingsVisibility() {
  const f = $('settingsForm').elements;
  $('difficultyField').hidden = f.opponent.value !== 'ai';
  $('policyField').hidden = f.turnSeconds.value === '';
}

// --- controls -----------------------------------------------------------

function wireControls() {
  $('menuBtn').addEventListener('click', () => {
    $('reseedBtn').disabled = game.history.length > 0;
    $('cantMoveBtn').disabled = game.isComputerTurn || game.status !== 'playing';
    $('menuTime').value = game.settings.turnSeconds === null ? '' : String(game.settings.turnSeconds);
    $('menuPolicy').value = game.settings.timeoutPolicy;
    $('menuPolicyField').hidden = game.settings.turnSeconds === null;
    $('menuDialog').showModal();
  });

  $('newGameBtn').addEventListener('click', () => { $('menuDialog').close(); openSettings(); });
  $('overNewBtn').addEventListener('click', () => { $('overDialog').close(); openSettings(); });

  $('reseedBtn').addEventListener('click', () => {
    $('menuDialog').close();
    game.reseed();
    startClock();
    render();
  });

  $('cantMoveBtn').addEventListener('click', async () => {
    $('menuDialog').close();
    setThinking(true, 'Checking for a move…');
    await nextFrame();
    const exists = game.anyMoveLeft();
    setThinking(false);
    if (exists && !confirm('There is still at least one word available. '
      + 'By the rules, a player who cannot move loses. Give up anyway?')) {
      render();
      return;
    }
    game.resign();
    stopClock();
    render();
  });

  $('settingsForm').addEventListener('change', syncSettingsVisibility);

  $('settingsDialog').addEventListener('close', () => {
    if ($('settingsDialog').returnValue !== 'start') return;
    const f = $('settingsForm').elements;
    game.reset({
      opponent: f.opponent.value,
      difficulty: f.difficulty.value,
      startMode: f.startMode.value,
      turnSeconds: f.turnSeconds.value === '' ? null : Number(f.turnSeconds.value),
      timeoutPolicy: f.timeoutPolicy.value,
    });
    saveSettings();
    startClock();
    render();
    maybeComputerTurn();
  });

  // Turn clock, changeable mid-game from the menu.
  const menuTime = $('menuTime');
  for (const s of TIME_OPTIONS) {
    const o = document.createElement('option');
    o.value = s === null ? '' : String(s);
    o.textContent = s === null ? 'Unlimited' : (s < 60 ? `${s} sec` : `${s / 60} min`);
    menuTime.appendChild(o);
  }
  menuTime.addEventListener('change', () => {
    game.settings.turnSeconds = menuTime.value === '' ? null : Number(menuTime.value);
    $('menuPolicyField').hidden = game.settings.turnSeconds === null;
    saveSettings();
    startClock();
    render();
  });
  $('menuPolicy').addEventListener('change', () => {
    game.settings.timeoutPolicy = $('menuPolicy').value;
    saveSettings();
  });

  $('confirmBtn').addEventListener('click', () => {
    if (!game.confirm()) { render(); return; }
    startClock();
    render();
    maybeComputerTurn();
  });
}

// --- computer turn ------------------------------------------------------

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function setThinking(on, label = 'Computer is thinking…') {
  thinking = on;
  const el = $('turnLabel');
  el.classList.toggle('thinking', on);
  if (on) el.textContent = label;
}

async function maybeComputerTurn() {
  if (!game.isComputerTurn) return;
  setThinking(true);
  stopClock();
  await nextFrame();
  await new Promise((r) => setTimeout(r, 350));   // let the move read as deliberate
  game.playComputerMove();
  setThinking(false);
  startClock();
  render();
}

// --- clock --------------------------------------------------------------

function stopClock() {
  if (clock) { clearInterval(clock); clock = null; }
  secondsLeft = null;
}

function startClock() {
  stopClock();
  if (game.status !== 'playing' || game.settings.turnSeconds === null) { renderTimer(); return; }
  if (game.isComputerTurn) { renderTimer(); return; }
  secondsLeft = game.settings.turnSeconds;
  renderTimer();
  clock = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      stopClock();
      game.handleTimeout();
      render();
      startClock();
      maybeComputerTurn();
    } else {
      renderTimer();
    }
  }, 1000);
}

function renderTimer() {
  const el = $('timer');
  if (secondsLeft === null) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${secondsLeft}s`;
  el.classList.toggle('low', secondsLeft <= 5);
}

// --- render -------------------------------------------------------------

function render() {
  const g = game.workingGrid;
  const path = game.selectedPath;

  for (let i = 0; i < CELLS; i++) {
    const el = cellEls[i];
    const letter = g[i];
    const order = path.indexOf(i);
    el.textContent = letter ? letter.toUpperCase() : '';
    if (order >= 0) {
      const tag = document.createElement('span');
      tag.className = 'order';
      tag.textContent = String(order + 1);
      el.appendChild(tag);
    }
    el.className = 'cell'
      + (letter ? '' : ' empty')
      + (!letter && game.canPlaceLetter(i) ? ' playable' : '')
      + (i === game.pendingCell ? ' pending' : '')
      + (order >= 0 ? ' inpath' : '')
      + (game.highlightPath.includes(i) ? ' highlight' : '');
  }

  const word = game.currentWord;
  $('currentWord').textContent = word.toUpperCase();
  $('wordPoints').textContent = word ? `${word.length} pts` : '';
  $('hint').hidden = word.length > 0;
  $('hint').textContent = game.pendingLetter === null
    ? 'Tap an empty square to add a letter'
    : 'Trace a word through your new letter. Tap it again to deselect, '
      + 'once more to take it back.';

  const err = $('error');
  err.hidden = !game.lastError;
  err.textContent = game.lastError || '';

  $('confirmBtn').disabled = !game.canConfirm || thinking;

  if (!thinking) {
    $('turnLabel').textContent = game.status === 'finished'
      ? 'Game over'
      : `${game.players[game.current].name} to move`;
  }

  renderScores();
  renderTimer();

  if (game.status === 'finished' && !$('overDialog').open) showGameOver();
}

function renderScores() {
  const wrap = $('scores');
  wrap.innerHTML = '';
  game.players.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'player' + (game.current === idx && game.status === 'playing' ? ' active' : '');

    const head = document.createElement('header');
    head.innerHTML = '<span class="dot"></span>';
    const name = document.createElement('span');
    name.textContent = p.name;
    const total = document.createElement('span');
    total.className = 'total';
    total.textContent = String(game.score(idx));
    head.append(name, total);
    card.appendChild(head);

    if (!p.words.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = '—';
      card.appendChild(none);
    } else {
      const ul = document.createElement('ul');
      [...p.words].reverse().forEach((w) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = w.word;
        const pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = `+${w.points}`;
        li.append(label, pts);
        li.addEventListener('click', () => showWord(w));
        li.addEventListener('pointerenter', () => { game.highlightPath = w.path; render(); });
        li.addEventListener('pointerleave', () => { game.highlightPath = []; render(); });
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }
    wrap.appendChild(card);
  });
}

function showWord(w) {
  game.highlightPath = w.path;
  render();
  $('wordTitle').textContent = w.word.toUpperCase();
  $('wordMeta').textContent = `${w.points} points · played by ${game.players[w.player].name}`;
  $('wordLookup').href = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(w.word)}`;
  $('wordDialog').showModal();
}

$('wordDialog')?.addEventListener('close', () => { game.highlightPath = []; render(); });

function showGameOver() {
  $('overTitle').textContent = game.winner === null
    ? 'Draw' : `${game.players[game.winner].name} wins`;
  $('overReason').textContent = game.endReason;
  $('overScore').textContent = `${game.score(0)} – ${game.score(1)}`;
  $('overDialog').showModal();
}

boot().catch(fatal);

// Test seam: lets the headless smoke test drive a real move through the same
// handlers the browser uses. Unused in production.
export const __test = {
  getGame: () => game,
  render,
  isThinking: () => thinking,
};
