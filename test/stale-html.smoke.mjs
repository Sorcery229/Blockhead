// Boots main.js against a DELIBERATELY OLD document — the set of element ids
// that existed in build 7, before the multiplayer controls and the menu clock.
//
//   cd web && jsc -m test/stale-html.smoke.mjs
//
// This reproduces what a browser does when it pairs a cached index.html with
// freshly fetched JavaScript. It shipped once: $('friendBtn').addEventListener
// threw on null and the whole app died with a blank page. Boot must now survive
// a document that is missing anything added since.

const nodeFs = typeof readFile === 'function' ? null : await import('node:fs');
const readText = (p) => (typeof readFile === 'function' ? readFile(p) : nodeFs.readFileSync(p, 'utf8'));
const out = typeof print === 'function' ? print : console.log;

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

// The ids build 7 shipped with. Anything newer is absent on purpose.
const BUILD7_IDS = new Set([
  'loading', 'app', 'menuBtn', 'turnLabel', 'timer', 'board',
  'currentWord', 'wordPoints', 'hint', 'error', 'cancelBtn', 'confirmBtn',
  'scores', 'letterDialog', 'letterGrid', 'settingsDialog', 'settingsForm',
  'difficultyField', 'policyField', 'menuDialog', 'newGameBtn', 'reseedBtn',
  'cantMoveBtn', 'overDialog', 'overTitle', 'overReason', 'overScore',
  'overNewBtn', 'wordDialog', 'wordTitle', 'wordMeta', 'wordLookup',
]);

const registry = new Map();
let fatalBannerText = null;

function makeEl(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, listeners,
    _class: '', _innerHTML: '', textContent: '', hidden: false, disabled: false,
    open: false, value: '', href: '', returnValue: '', removed: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get className() { return el._class; },
    set className(v) { el._class = String(v); },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v); el.children.length = 0; },
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { el.children.push(...cs); },
    remove() { el.removed = true; },
    setAttribute() {}, setPointerCapture() {}, releasePointerCapture() {},
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    showModal() { el.open = true; },
    close(v) { el.open = false; if (v !== undefined) el.returnValue = v; },
    fire(t, ev = {}) { (listeners[t] || []).forEach((f) => f(ev)); },
    select() {},
  };
  el.elements = new Proxy({}, {
    get(store, name) {
      if (typeof name !== 'string') return undefined;
      if (!store[name]) store[name] = makeEl('select');
      return store[name];
    },
  });
  return el;
}

globalThis.document = {
  getElementById(id) {
    if (!BUILD7_IDS.has(id)) return null;          // the stale document
    if (!registry.has(id)) registry.set(id, makeEl());
    return registry.get(id);
  },
  createElement: (tag) => makeEl(tag),
  elementFromPoint: () => null,
  querySelector: (sel) => {
    if (sel !== 'h1') return null;
    if (!registry.has('__h1')) registry.set('__h1', makeEl('h1'));
    return registry.get('__h1');
  },
  get body() {
    if (!registry.has('__body')) registry.set('__body', makeEl('body'));
    return registry.get('__body');
  },
};

globalThis.localStorage = { _v: {}, getItem(k) { return this._v[k] ?? null; }, setItem(k, v) { this._v[k] = v; } };
globalThis.navigator = {};
globalThis.location = { origin: 'https://example.test', pathname: '/', hash: '', search: '' };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.setTimeout = (fn) => { fn(); return 0; };
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.fetch = (path) => Promise.resolve({ text: () => Promise.resolve(readText(`public/${path}`)) });

try {
  await import('../public/js/main.js');
  for (let i = 0; i < 80; i++) {
    if (typeof drainMicrotasks === 'function') drainMicrotasks();
    await Promise.resolve();
  }
} catch (e) {
  problems.push(`import threw: ${e && e.message ? e.message : e}`);
}

const body = registry.get('__body');
fatalBannerText = (body?.children || [])
  .filter((c) => c._class === 'fatal')
  .map((c) => c.textContent)[0] || null;

check(!fatalBannerText, `boot failed on a stale document: ${fatalBannerText}`);
check(registry.get('app')?.hidden === false, 'app should still be revealed');
check(registry.get('board')?.children.length === 25, 'board should still render 25 cells');
check(registry.get('scores')?.children.length === 2, 'score panel should still render');
check(registry.get('loading')?.removed === true, 'loading overlay should still be removed');
check((registry.get('confirmBtn')?.listeners.click || []).length > 0,
  'Confirm should still be wired on an old document');

out(problems.length
  ? `\n${problems.length} problem(s):`
  : '\nStale-HTML smoke test passed — boot survives a build-7 document');
for (const p of problems) out(`  FAIL  ${p}`);
if (problems.length) throw new Error(`${problems.length} problem(s)`);
