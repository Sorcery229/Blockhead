import { WordDictionary } from './dictionary.js';
import { CELLS, SIZE } from './board.js';
import { BlockheadGame, TIME_OPTIONS, DEFAULT_SETTINGS } from './game.js';
import * as online from './online.js';
import * as definitions from './definitions.js';

// Bumped whenever the shipped files change, so "which build am I running?" is
// answerable from the console instead of guessed at.
const BUILD = '15';

// A browser will happily pair a cached older index.html with fresh JavaScript.
// When that happens an element this script expects may simply not exist, and
// one `null.addEventListener` used to abort boot and leave a dead page. Any
// missing element now resolves to an inert stand-in: handlers attach to
// nothing, property writes go nowhere, reads give harmless defaults, and the
// rest of the app carries on. Typos are still caught — the UI smoke test
// asserts every id used here exists in index.html.
const reportedMissing = new Set();

function missingElement(id) {
  if (!reportedMissing.has(id)) {
    reportedMissing.add(id);
    globalThis.console?.warn?.(
      `Blockhead build ${BUILD}: no #${id} in this document — stale HTML?`);
  }
  return new Proxy(function noop() {}, {
    get(_target, prop) {
      switch (prop) {
        case 'value':
        case 'textContent':
        case 'innerHTML':
          return '';
        case 'hidden':
        case 'disabled':
          return true;
        case 'open':
          return false;
        case 'children':
          return [];
        case 'classList':
          return { add() {}, remove() {}, toggle() {}, contains: () => false };
        case 'style':
          return {};
        case 'dataset':
          return {};
        default:
          return () => undefined;
      }
    },
    set() { return true; },
    apply() { return undefined; },
  });
}

const $ = (id) => document.getElementById(id) || missingElement(id);
const SETTINGS_KEY = 'blockhead.settings';

let game = null;
let clock = null;
let secondsLeft = null;
let thinking = false;

/** Shared-game state. `role` is which player index this device controls. */
const net = {
  active: false,
  id: null,
  role: 0,
  seq: 0,
  poller: null,
  error: null,
  opponentJoined: false,
};

const roleKey = (id) => `blockhead.role.${id}`;
/** True when this device is allowed to act right now. */
const myTurn = () => !net.active || game.current === net.role;

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
    `Blockhead build ${BUILD}: ${dict.count} words — `
    + `fetch ${Math.round(tFetched - t0)} ms, parse ${Math.round(tParsed - tFetched)} ms`,
  );

  game = new BlockheadGame(dict, loadSettings());
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

  // Online play is optional: with no Firebase config the button stays hidden
  // and everything else works exactly as before.
  const configured = await online.loadConfig();
  $('friendBtn').hidden = !configured;
  const invited = /[#?]g=([a-z0-9]+)/i.exec(location.hash + location.search);
  if (configured && invited) {
    await joinSharedGame(invited[1]);
  }

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
  globalThis.console?.error?.('Blockhead failed to start:', err);
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = `Blockhead build ${BUILD} failed to start — ${message}`;
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
    if (thinking || game.status !== 'playing' || !myTurn()) return;
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

let pickedLetter = null;
const letterButtons = [];

function buildLetterGrid() {
  const grid = $('letterGrid');
  grid.innerHTML = '';
  letterButtons.length = 0;
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = letter.toUpperCase();
    // Picking highlights; nothing reaches the board until Place is pressed, so
    // a mistyped letter costs one more tap rather than an undo.
    b.addEventListener('click', () => {
      pickedLetter = letter;
      for (const other of letterButtons) other.classList.remove('picked');
      b.classList.add('picked');
      $('letterPlaceBtn').disabled = false;
    });
    letterButtons.push(b);
    grid.appendChild(b);
  }
}

function openLetterPicker(i) {
  pickerCell = i;
  pickedLetter = null;
  for (const b of letterButtons) b.classList.remove('picked');
  $('letterPlaceBtn').disabled = true;
  $('letterDialog').showModal();
}

function placePickedLetter() {
  if (pickerCell === null || pickedLetter === null) return;
  // Deliberately do NOT put the new cell into the path here. The word only has
  // to *pass through* the new letter — it may sit at the start, middle or end.
  game.placeLetter(pickedLetter, pickerCell);
  pickerCell = null;
  pickedLetter = null;
  $('letterDialog').close();
  render();
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
  f.allowChallenge.value = game.settings.allowChallenge === false ? 'no' : 'yes';
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
    if (net.active) pushSharedState();
  });

  $('settingsForm').addEventListener('change', syncSettingsVisibility);

  $('settingsDialog').addEventListener('close', () => {
    if ($('settingsDialog').returnValue !== 'start') return;
    // Starting a local game ends any shared session.
    if (net.active) {
      net.poller?.dispose();
      net.active = false;
      net.id = null;
      net.error = null;
      setOnlineMessage('');
      history.replaceState(null, '', location.pathname);
    }
    const f = $('settingsForm').elements;
    game.reset({
      opponent: f.opponent.value,
      difficulty: f.difficulty.value,
      startMode: f.startMode.value,
      turnSeconds: f.turnSeconds.value === '' ? null : Number(f.turnSeconds.value),
      timeoutPolicy: f.timeoutPolicy.value,
      allowChallenge: f.allowChallenge.value !== 'no',
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

  $('letterPlaceBtn').addEventListener('click', placePickedLetter);
  $('letterCancelBtn').addEventListener('click', () => {
    pickerCell = null;
    pickedLetter = null;
    $('letterDialog').close();
  });

  $('cancelBtn').addEventListener('click', () => {
    game.clearPending();
    render();
  });

  // Always enabled: pressing it tells you what's wrong, or opens the
  // does-this-word-exist question, rather than being silently unavailable.
  $('confirmBtn').addEventListener('click', () => {
    if (!myTurn()) return;
    const result = game.submit();
    if (result.outcome === 'played') {
      startClock();
      render();
      if (net.active) pushSharedState();
      else maybeComputerTurn();
      return;
    }
    if (result.outcome === 'challenge') {
      openOwnClaim(result.word);
      return;
    }
    render();
  });

  $('claimYesBtn').addEventListener('click', () => {
    $('claimDialog').close();
    if (claimMode === 'own') acceptOwnClaim();
    else resolveOpponentClaim(true);
  });

  $('claimNoBtn').addEventListener('click', () => {
    $('claimDialog').close();
    if (claimMode === 'own') render();          // back to editing
    else resolveOpponentClaim(false);
  });

  $('friendBtn').addEventListener('click', () => {
    $('menuDialog').close();
    hostSharedGame();
  });

  $('copyLinkBtn').addEventListener('click', async () => {
    const link = $('shareLink').value;
    try {
      await navigator.clipboard.writeText(link);
      $('copyLinkBtn').textContent = 'Copied';
      setTimeout(() => { $('copyLinkBtn').textContent = 'Copy link'; }, 1500);
    } catch {
      $('shareLink').select?.();
      $('copyLinkBtn').textContent = 'Select and copy';
    }
  });

  $('shareSheetBtn').addEventListener('click', () => {
    navigator.share?.({
      title: 'Blockhead',
      text: 'Your move — Blockhead word game',
      url: $('shareLink').value,
    }).catch(() => {});
  });
}

// --- unknown words ------------------------------------------------------

let claimMode = 'own';   // 'own' = asking the player; 'verdict' = asking the opponent

function openOwnClaim(word) {
  claimMode = 'own';
  $('claimTitle').textContent = 'Does this word exist?';
  $('claimWord').textContent = word;
  $('claimBody').textContent = "It isn't in the dictionary. Tap ✓ if you're sure "
    + "it's a word and your opponent will be asked to allow it.";
  $('claimDialog').showModal();
}

function openOpponentClaim(claim) {
  claimMode = 'verdict';
  $('claimTitle').textContent = 'Does this word exist?';
  $('claimWord').textContent = claim.word;
  const who = game.players[claim.by] ? game.players[claim.by].name : 'Your opponent';
  $('claimBody').textContent = `${who} says this is a word. Tap ✓ to allow it and `
    + 'award the points, or ✗ to refuse.';
  $('claimDialog').showModal();
}

function acceptOwnClaim() {
  if (!game.claimWord()) { render(); return; }
  const claim = game.pendingClaim;

  if (net.active) {
    // The opponent's device will see the claim on its next poll.
    pushSharedState();
    render();
    return;
  }
  if (game.players[1 - claim.by] && game.players[1 - claim.by].isComputer) {
    // The computer's only authority on words is the lexicon, so it declines.
    game.resolveClaim(false);
    render();
    return;
  }
  openOpponentClaim(claim);     // pass and play: hand the device over
}

function resolveOpponentClaim(accepted) {
  game.resolveClaim(accepted);
  startClock();
  render();
  if (net.active) pushSharedState();
  else if (accepted) maybeComputerTurn();
}

/** After a poll, show the question if the opponent has claimed a word. */
function maybeShowIncomingClaim() {
  const claim = game.pendingClaim;
  const dialog = $('claimDialog');
  if (!claim) {
    if (dialog.open && claimMode === 'verdict') dialog.close();
    return;
  }
  if (net.active && claim.by !== net.role && !dialog.open) openOpponentClaim(claim);
}

// --- shared games -------------------------------------------------------

function shareUrl(id) {
  return `${location.origin}${location.pathname}#g=${id}`;
}

function setOnlineMessage(text, kind = '') {
  const bar = $('onlineBar');
  bar.hidden = !text;
  bar.textContent = text || '';
  bar.className = `onlinebar${kind ? ` ${kind}` : ''}`;
}

async function hostSharedGame() {
  stopClock();
  game.reset({ opponent: 'human' });
  game.players[0].name = 'Player 1';
  game.players[1].name = 'Player 2';
  setOnlineMessage('Creating game…');
  render();
  try {
    const { id, seq } = await online.createGame(game.toJSON());
    net.active = true;
    net.id = id;
    net.role = 0;
    net.seq = seq;
    net.error = null;
    try { localStorage.setItem(roleKey(id), '0'); } catch { /* private mode */ }
    startPolling();
    $('shareLink').value = shareUrl(id);
    $('shareSheetBtn').hidden = typeof navigator.share !== 'function';
    $('shareDialog').showModal();
    render();
  } catch (err) {
    net.active = false;
    setOnlineMessage(err.message, 'error');
  }
}

async function joinSharedGame(id) {
  setOnlineMessage('Joining game…');
  try {
    const snapshot = await online.fetchGame(id);
    if (!snapshot) {
      setOnlineMessage(`No game found for link "${id}". Ask for a fresh invite.`, 'error');
      return;
    }
    let role = 1;
    try {
      const stored = localStorage.getItem(roleKey(id));
      if (stored !== null) role = Number(stored);
      else localStorage.setItem(roleKey(id), '1');
    } catch { /* private mode: default to guest */ }

    game.loadFrom(snapshot.state);
    net.active = true;
    net.id = id;
    net.role = role;
    net.seq = snapshot.seq;
    net.error = null;
    startPolling();
    startClock();
    render();
  } catch (err) {
    setOnlineMessage(err.message, 'error');
  }
}

function startPolling() {
  if (net.poller) net.poller.dispose();
  net.poller = online.createPoller({
    id: net.id,
    getLastSeq: () => net.seq,
    onUpdate: (snapshot) => {
      net.seq = snapshot.seq;
      net.error = null;
      try {
        game.loadFrom(snapshot.state);
      } catch (err) {
        setOnlineMessage(`Could not read the opponent's move: ${err.message}`, 'error');
        return;
      }
      syncPolling();
      startClock();
      render();
      maybeShowIncomingClaim();
    },
    onError: (err) => {
      net.error = err.message;
      render();
    },
  });
  syncPolling();
}

/** Only poll while waiting on the opponent — an idle game then costs nothing. */
function syncPolling() {
  if (!net.poller) return;
  if (net.active && game.status === 'playing' && !myTurn()) net.poller.start();
  else net.poller.stop();
}

async function pushSharedState() {
  if (!net.active) return;
  try {
    net.seq = await online.pushGame(net.id, game.toJSON(), net.seq + 1);
    net.error = null;
  } catch (err) {
    net.error = `Move not sent: ${err.message}`;
  }
  syncPolling();
  render();
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
  // In a shared game each device only runs its own clock.
  if (net.active && !myTurn()) { renderTimer(); return; }
  secondsLeft = game.settings.turnSeconds;
  renderTimer();
  clock = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      stopClock();
      game.handleTimeout();
      render();
      startClock();
      if (net.active) pushSharedState();
      else maybeComputerTurn();
    } else {
      renderTimer();
    }
  }, 1000);
}

function renderTimer() {
  const el = $('timer');
  if (secondsLeft === null) { el.hidden = true; return; }
  el.hidden = false;
  $('timerValue').textContent = String(secondsLeft);
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
    // An arrow in the gap towards the next cell, rather than a sequence
    // number inside it: the direction of travel is what you're checking when
    // you trace a word, and it reads without counting.
    if (order >= 0 && order < path.length - 1) {
      const step = path[order + 1] - i;
      const dir = { 1: 'right', '-1': 'left', [SIZE]: 'down', [-SIZE]: 'up' }[step];
      if (dir) {
        // Empty span — the triangle is drawn entirely in CSS, so it can't be
        // resized or reshaped by a font fallback.
        const arrow = document.createElement('span');
        arrow.className = `arrow ${dir}`;
        arrow.setAttribute('aria-hidden', 'true');
        el.appendChild(arrow);
      }
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
  // No standing instructions under the board at all — they were permanent
  // furniture for something you learn on the first turn.
  $('hint').textContent = '';

  const err = $('error');
  err.hidden = !game.lastError;
  err.textContent = game.lastError || '';

  // Confirm stays enabled so pressing it can explain the problem or offer the
  // does-this-word-exist route. It's only disabled when acting is impossible.
  $('confirmBtn').disabled = thinking || !myTurn() || game.status !== 'playing';
  $('cancelBtn').disabled = game.pendingCell === null && path.length === 0;

  if (!thinking) {
    if (game.status === 'finished') {
      $('turnLabel').textContent = 'Game over';
    } else if (net.active) {
      $('turnLabel').textContent = myTurn() ? 'Your move' : "Opponent's move";
    } else {
      $('turnLabel').textContent = `${game.players[game.current].name} to move`;
    }
  }

  if (net.active) {
    if (net.error) setOnlineMessage(net.error, 'error');
    else if (game.status !== 'playing') setOnlineMessage('Game over — share a new link to play again.');
    else if (myTurn()) setOnlineMessage(`Shared game ${net.id} — your turn.`);
    else setOnlineMessage(`Shared game ${net.id} — waiting for your opponent…`, 'waiting');
  }

  renderScores();
  renderTimer();

  if (game.status === 'finished' && !$('overDialog').open) showGameOver();
}

/** Repaints only the board's highlight ring, leaving the DOM otherwise intact. */
function applyHighlight(path) {
  game.highlightPath = path;
  for (let i = 0; i < cellEls.length; i++) {
    cellEls[i].classList.toggle('highlight', path.includes(i));
  }
}

function renderScores() {
  // Three containers: the two side columns used on a wide screen, and the
  // stacked pair used on a phone. CSS shows whichever fits; a DOM node can
  // only live in one place, so each card is built for each container.
  const left = $('scoreLeft');
  const right = $('scoreRight');
  const stacked = $('scores');
  left.innerHTML = '';
  right.innerHTML = '';
  stacked.innerHTML = '';
  game.players.forEach((p, idx) => {
    (idx === 0 ? left : right).appendChild(playerCard(p, idx));
    stacked.appendChild(playerCard(p, idx));
  });
}

function playerCard(p, idx) {
  {
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
        if (w.challenged) {
          const mark = document.createElement('span');
          mark.className = 'challenged';
          mark.textContent = '✱';
          mark.title = 'Allowed by the opponent, not in the dictionary';
          label.appendChild(mark);
        }
        const pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = `+${w.points}`;
        li.append(label, pts);
        if (!w.skipped) {
          definitions.prefetch(w.word);
          li.addEventListener('click', () => showWord(w));
          // Highlighting must NOT go through render(): render() rebuilds these
          // list items, so on any pointer device the hover that precedes a tap
          // replaced this element and the click never landed on a live node —
          // which is why tapping a word did nothing. Touch the board only.
          li.addEventListener('pointerenter', () => applyHighlight(w.path));
          li.addEventListener('pointerleave', () => applyHighlight([]));
        } else {
          li.classList.add('skipped');
        }
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }
    return card;
  }
}

function showWord(w) {
  applyHighlight(w.path);
  $('wordTitle').textContent = w.word.toUpperCase();
  const who = game.players[w.player] ? game.players[w.player].name : 'unknown';
  $('wordMeta').textContent = `${w.points} points · played by ${who}`
    + (w.challenged ? ' · allowed by agreement, not in the dictionary' : '');
  $('wordDialog').showModal();
  loadDefinition(w.word);
}

/** Meanings come from the bundled WordNet glosses — no network call, nothing
 *  to time out, and no link to follow. See js/definitions.js. */
async function loadDefinition(word) {
  const box = $('wordDefinition');
  box.textContent = '';

  const entry = await definitions.lookup(word);
  if (!entry) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'No definition for this word in the bundled dictionary.';
    box.appendChild(none);
    return;
  }

  const bits = [];
  if (entry.partOfSpeech) bits.push(entry.partOfSpeech);
  if (entry.base) bits.push(`from “${entry.base}”`);
  if (entry.generated) bits.push('machine-written');
  if (bits.length) {
    const pos = document.createElement('div');
    pos.className = 'pos';
    pos.textContent = bits.join(' · ');
    box.appendChild(pos);
  }

  const text = document.createElement('div');
  text.textContent = entry.definition;
  box.appendChild(text);
}

$('wordDialog')?.addEventListener('close', () => applyHighlight([]));

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
