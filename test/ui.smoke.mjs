// Boots main.js against a stub DOM that only knows the element ids actually
// declared in index.html — so a typo'd getElementById fails here instead of
// silently producing a dead button in the browser.
//
//   cd web && jsc -m test/ui.smoke.mjs

const out = typeof print === 'function' ? print : console.log;
const nodeFs = typeof readFile === 'function' ? null : await import('node:fs');
const readText = (p) => (typeof readFile === 'function' ? readFile(p) : nodeFs.readFileSync(p, 'utf8'));

const html = readText('public/index.html');
const knownIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const formNames = new Set([...html.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]));

const problems = [];
const touchedIds = new Set();

// --- stub DOM -----------------------------------------------------------

function makeEl(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    listeners,
    _class: '',
    textContent: '',
    _innerHTML: '',
    hidden: false,
    disabled: false,
    open: false,
    value: '',
    href: '',
    returnValue: '',
    classList: {
      add() {}, remove() {}, toggle() {},
      contains: (c) => el._class.split(/\s+/).includes(c),
    },
    get className() { return el._class; },
    set className(v) { el._class = String(v); },
    // A real DOM drops existing children when innerHTML is reassigned.
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v); el.children.length = 0; },
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { el.children.push(...cs); },
    removed: false,
    remove() { el.removed = true; },
    setAttribute() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    showModal() { el.open = true; },
    close(v) { el.open = false; if (v !== undefined) el.returnValue = v; (listeners.close || []).forEach((f) => f()); },
    fire(type, ev = {}) { (listeners[type] || []).forEach((f) => f(ev)); },
  };
  // Form element collections: settingsForm.elements.<name>
  el.elements = new Proxy({}, {
    get(store, name) {
      if (typeof name !== 'string') return undefined;
      if (!formNames.has(name)) problems.push(`form control "${name}" not declared in index.html`);
      if (!store[name]) store[name] = makeEl('select');
      return store[name];
    },
  });
  return el;
}

const registry = new Map();

globalThis.document = {
  getElementById(id) {
    touchedIds.add(id);
    if (!knownIds.has(id)) {
      problems.push(`getElementById("${id}") — no such id in index.html`);
      return null;
    }
    if (!registry.has(id)) registry.set(id, makeEl());
    return registry.get(id);
  },
  createElement: (tag) => makeEl(tag),
  elementFromPoint: () => hitCell,
  querySelector(sel) {
    if (sel === 'h1') {
      if (!registry.has('__h1')) registry.set('__h1', makeEl('h1'));
      return registry.get('__h1');
    }
    return null;
  },
  get body() {
    if (!registry.has('__body')) registry.set('__body', makeEl('body'));
    return registry.get('__body');
  },
};

// Which cell a simulated pointer event lands on.
let hitCell = null;

globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = v; },
};
globalThis.navigator = {};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;
// Always override: JavaScriptCore has a real setTimeout, but nothing pumps its
// run loop once the module body finishes, so a deferred callback would never
// fire and every `await` behind one would hang. Fire synchronously instead.
globalThis.setTimeout = (fn) => { fn(); return 0; };
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};

globalThis.fetch = (path) => Promise.resolve({
  text: () => Promise.resolve(readText(`public/${path}`)),
});

// --- boot ---------------------------------------------------------------

const settle = async () => {
  for (let i = 0; i < 80; i++) {
    if (typeof drainMicrotasks === 'function') drainMicrotasks();
    await Promise.resolve();
  }
};

let booted = false;
let mod = null;
try {
  mod = await import('../public/js/main.js');
  // boot() is async; let its promise chain settle.
  for (let i = 0; i < 50; i++) {
    if (typeof drainMicrotasks === 'function') drainMicrotasks();
    await Promise.resolve();
  }
  booted = true;
} catch (e) {
  problems.push(`main.js threw during boot: ${e && e.message ? e.message : e}`);
}

// --- assertions ---------------------------------------------------------

function check(cond, msg) { if (!cond) problems.push(msg); }

check(booted, 'module did not finish loading');

const board = registry.get('board');
check(board && board.children.length === 25,
  `board should render 25 cells, got ${board ? board.children.length : 'none'}`);

const letters = registry.get('letterGrid');
check(letters && letters.children.length === 26,
  `letter picker should have 26 buttons, got ${letters ? letters.children.length : 'none'}`);

const scores = registry.get('scores');
check(scores && scores.children.length === 2,
  `score panel should render 2 players, got ${scores ? scores.children.length : 'none'}`);

check(registry.get('loading')?.removed === true, 'loading overlay should be removed from the DOM after boot');
check(registry.get('app')?.hidden === false, 'app should be revealed after boot');

// The build badge must actually get stamped, so "which build is on the phone?"
// is readable without Web Inspector.
const declaredBuild = (readText('public/js/main.js').match(/BUILD\s*=\s*'([^']+)'/) || [])[1];
check(!!declaredBuild, 'could not find BUILD in main.js');
check(registry.get('build')?.textContent === `build ${declaredBuild}`,
  `header badge should read "build ${declaredBuild}", got "${registry.get('build')?.textContent}"`);

// With no Firebase config present, online play must stay hidden rather than
// offering a button that fails when tapped.
check(registry.get('friendBtn')?.hidden === true,
  'Play-a-friend should be hidden when firebase-config.js has no project');

// Regression guard. `hidden` is only `display:none` in the UA stylesheet, so a
// single author rule setting `display` defeats it everywhere. This shipped once
// — the loading overlay stayed over the board and swallowed every tap.
const css = readText('public/styles.css');
check(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
  'styles.css must carry a global [hidden] { display: none !important } rule');

// Anything main.js hides must survive the cascade.
const hiddenTargets = [...readText('public/js/main.js').matchAll(/\$\('(\w+)'\)\.hidden/g)]
  .map((m) => m[1]);
for (const id of new Set(hiddenTargets)) {
  check(knownIds.has(id), `main.js hides "${id}" which is not in index.html`);
}

// Buttons must actually be wired.
for (const id of ['menuBtn', 'confirmBtn', 'newGameBtn', 'reseedBtn',
                  'cantMoveBtn', 'overNewBtn']) {
  const el = registry.get(id);
  check(el && (el.listeners.click || []).length > 0, `${id} has no click handler`);
}

// Clicking Confirm with nothing staged must not throw.
try {
  registry.get('confirmBtn').fire('click');
} catch (e) {
  problems.push(`confirm with no pending move threw: ${e.message}`);
}

// --- drive a real move through the browser handlers ---------------------

const { emptyGrid, placeWord, indexOf } = await import('../public/js/board.js');

const game = mod?.__test?.getGame?.();
check(!!game, 'test seam not exported from main.js');

if (game) {
  // Fixed position: "board" across the middle row, so the move is deterministic.
  game.setPosition(placeWord(emptyGrid(), 'board', 2), ['board']);
  mod.__test.render();

  const cellEl = (i) => board.children[i];
  const tap = (i) => {
    hitCell = cellEl(i);
    board.fire('pointerdown', { clientX: 1, clientY: 1, pointerId: 1 });
    board.fire('pointerup', { clientX: 1, clientY: 1, pointerId: 1 });
  };

  // Tap the empty square above the "O" → letter picker opens.
  tap(indexOf(1, 1));
  check(registry.get('letterDialog')?.open === true, 'letter picker did not open');

  // Choose T.
  const tBtn = letters.children[19];
  check(tBtn?.textContent === 'T', `expected T at index 19, got ${tBtn?.textContent}`);
  tBtn?.fire?.('click');
  check(game.pendingLetter === 't', `pending letter should be t, got ${game.pendingLetter}`);
  check(registry.get('letterDialog')?.open === false, 'letter picker should close after a pick');

  // Picking a letter must NOT pre-seed the path. Seeding it forced every word
  // to begin with the new letter, which is not the rule.
  check(game.selectedPath.length === 0,
    `path should be empty after placing a letter, got ${JSON.stringify(game.selectedPath)}`);

  // Trace B → O → T: the new letter is LAST, not first.
  tap(indexOf(2, 0));
  tap(indexOf(2, 1));
  tap(indexOf(1, 1));
  check(game.currentWord === 'bot', `traced word should be bot, got "${game.currentWord}"`);
  check(game.selectedPath.indexOf(indexOf(1, 1)) === 2,
    'the new letter should be the third cell of the path');
  check(registry.get('confirmBtn')?.disabled === false, 'Confirm should be enabled for a valid word');

  registry.get('confirmBtn').fire('click');
  check(game.score(0) === 3, `score should be 3, got ${game.score(0)}`);
  check(scores.children.length === 2, 'score panel should still render both players');

  // Tapping a played word opens the definition sheet.
  const firstWordRow = scores.children[0].children[1]?.children?.[0];
  firstWordRow?.fire?.('click');
  check(registry.get('wordTitle')?.textContent === 'BOT',
    `word sheet title should be BOT, got "${registry.get('wordTitle')?.textContent}"`);
  registry.get('wordDialog').close();

  // Confirming handed the turn to the computer; let its move finish, otherwise
  // the `thinking` guard (correctly) swallows the taps below.
  await settle();
  check(mod.__test.isThinking() === false, 'computer turn should have completed');

  // The three-tap cycle on the new letter replaces the old Cancel button, and
  // it has to work through the real pointer handlers, not just the engine.
  game.setPosition(placeWord(emptyGrid(), 'board', 2), ['board']);
  mod.__test.render();
  const newCell = indexOf(1, 1);
  tap(newCell);
  letters.children[19]?.fire?.('click');          // T
  check(game.selectedPath.length === 0, 'placing a letter must not pre-select it');

  tap(newCell);
  check(game.selectedPath.length === 1, 'first tap should select the new letter');
  tap(newCell);
  check(game.selectedPath.length === 0, 'second tap should deselect it');
  check(game.pendingLetter === 't', 'second tap must leave the letter on the board');
  tap(newCell);
  check(game.pendingLetter === null, 'third tap should remove the letter');
  check(game.grid[newCell] === '', 'removing must not touch the committed board');
}

// --- menu, settings, game over -----------------------------------------

registry.get('menuBtn').fire('click');
check(registry.get('menuDialog')?.open === true, 'menu did not open');

registry.get('newGameBtn').fire('click');
check(registry.get('settingsDialog')?.open === true, 'settings did not open');
registry.get('settingsDialog').close('cancel');

if (game) {
  game.resign();
  mod.__test.render();
  check(registry.get('overDialog')?.open === true, 'game-over sheet did not open');
  check(registry.get('overTitle')?.textContent.includes('wins'),
    `game-over title should name a winner, got "${registry.get('overTitle')?.textContent}"`);
}

// Ids declared but never used are dead markup worth knowing about.
const unused = [...knownIds].filter((id) => !touchedIds.has(id)
  && !['app', 'loading', 'board', 'scores'].includes(id));

out(`\nids referenced: ${touchedIds.size} · declared: ${knownIds.size}`);
if (unused.length) out(`unused ids (styling/markup only): ${unused.join(', ')}`);
out(problems.length ? `\n${problems.length} problem(s):` : '\nUI smoke test passed');
for (const p of problems) out(`  FAIL  ${p}`);
if (problems.length) throw new Error(`${problems.length} problem(s)`);
