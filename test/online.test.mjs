// Tests for the shareable-game layer that do not need a network:
// serialisation round-trips, Firestore's typed-value encoding, id generation
// and the poller's scheduling.
//
//   cd web && jsc -m test/online.test.mjs      (or: node test/online.test.mjs)
//
// The HTTP calls themselves are exercised against a stub fetch, so request
// shape and error handling are covered; what is NOT covered is a real
// Firestore accepting them.

const nodeFs = typeof readFile === 'function' ? null : await import('node:fs');
const readText = (p) => (typeof readFile === 'function' ? readFile(p) : nodeFs.readFileSync(p, 'utf8'));
const out = typeof print === 'function' ? print : console.log;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e && e.message ? e.message : e}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e && e.message ? e.message : e}`); }
}
function ok(c, m = 'expected truthy') { if (!c) throw new Error(m); }
function eq(a, b, m = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
}

import { WordDictionary, codes } from '../public/js/dictionary.js';
import { emptyGrid, placeWord, indexOf, isFull } from '../public/js/board.js';
import { BlockheadGame } from '../public/js/game.js';
import { encodeDoc, decodeDoc, newGameId, createPoller } from '../public/js/online.js';

const dict = new WordDictionary(
  readText('public/words.txt'),
  readText('public/starters5.txt'),
  readText('public/starters3.txt'),
);

function playedGame() {
  const g = new BlockheadGame(dict, { opponent: 'human', turnSeconds: 30 });
  g.setPosition(placeWord(emptyGrid(), 'board', 2), ['board']);
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  g.tapCell(indexOf(2, 0));
  g.tapCell(indexOf(2, 1));
  g.tapCell(cell);
  g.confirm();                       // "bot" by player 0
  return g;
}

// --- serialisation ------------------------------------------------------

test('a game survives a JSON round trip', () => {
  const a = playedGame();
  const snapshot = JSON.parse(JSON.stringify(a.toJSON()));

  const b = new BlockheadGame(dict, { opponent: 'human' });
  b.loadFrom(snapshot);

  eq(b.grid, a.grid, 'grid');
  eq([...b.usedWords].sort(), [...a.usedWords].sort(), 'used words');
  eq(b.current, a.current, 'turn');
  eq(b.score(0), a.score(0), 'score 0');
  eq(b.score(1), a.score(1), 'score 1');
  eq(b.players[0].words.map((w) => w.word), ['bot'], 'played words');
  eq(b.players[0].words[0].path, a.players[0].words[0].path, 'word path');
  eq(b.settings.turnSeconds, 30, 'settings travel with the game');
});

test('a restored game keeps playing correctly', () => {
  const a = playedGame();
  const b = new BlockheadGame(dict, { opponent: 'human' }).loadFrom(a.toJSON());

  // "bot" is already used, so the restored game must reject it again.
  const cell = indexOf(3, 1);
  b.placeLetter('t', cell);
  b.tapCell(indexOf(2, 0));
  b.tapCell(indexOf(2, 1));
  b.tapCell(cell);
  eq(b.currentWord, 'bot');
  ok(b.validate() && b.validate().includes('already been played'),
    `expected a duplicate-word error, got "${b.validate()}"`);
});

test('a finished game round trips its result', () => {
  const a = playedGame();
  a.resign();
  const b = new BlockheadGame(dict, { opponent: 'human' }).loadFrom(a.toJSON());
  eq(b.status, 'finished');
  eq(b.winner, a.winner);
  ok(b.endReason.length > 0);
});

test('loadFrom rejects junk rather than half-applying it', () => {
  const g = new BlockheadGame(dict, { opponent: 'human' });
  let threw = 0;
  for (const bad of [null, {}, { v: 2 }, { v: 1, grid: 'abc' }]) {
    try { g.loadFrom(bad); } catch { threw++; }
  }
  eq(threw, 4, 'every malformed snapshot should throw');
});

// --- Firestore document encoding ---------------------------------------

test('document encoding round trips', () => {
  const state = playedGame().toJSON();
  const doc = encodeDoc(state, 7);
  eq(Object.keys(doc.fields).sort(), ['seq', 'state']);
  ok(typeof doc.fields.state.stringValue === 'string');
  eq(doc.fields.seq.integerValue, '7', 'Firestore integers travel as strings');

  const back = decodeDoc(doc);
  eq(back.seq, 7);
  eq(back.state.grid, state.grid);
});

test('decoding tolerates malformed documents', () => {
  eq(decodeDoc(null), null);
  eq(decodeDoc({}), null);
  eq(decodeDoc({ fields: {} }), null);
  eq(decodeDoc({ fields: { state: { stringValue: 'not json' } } }), null);
  eq(decodeDoc({ fields: { state: { stringValue: '{"a":1}' } } }), { state: { a: 1 }, seq: 0 });
});

test('the write payload stays well inside the 50 kB rule limit', () => {
  // Worst case: a full board with every cell played.
  const g = new BlockheadGame(dict, { opponent: 'human' });
  g.setPosition(placeWord(emptyGrid(), 'board', 2), ['board']);
  let guard = 0;
  while (!isFull(g.grid) && guard++ < 40) {
    g.players[0].isComputer = true;
    g.players[1].isComputer = true;
    if (!g.playComputerMove()) break;
  }
  const bytes = JSON.stringify(encodeDoc(g.toJSON(), 99)).length;
  ok(bytes < 50000, `payload is ${bytes} bytes, rule allows 50000`);
  ok(isFull(g.grid), 'expected a full board for the worst case');
});

// --- ids ----------------------------------------------------------------

test('game ids avoid ambiguous characters', () => {
  const id = newGameId(new Uint8Array([0, 1, 2, 3, 4, 5, 6]));
  eq(id.length, 7);
  ok(!/[aeiou01lo]/.test(id), `id "${id}" should avoid vowels and lookalikes`);
  const other = newGameId(new Uint8Array([9, 9, 9, 9, 9, 9, 9]));
  ok(id !== other, 'different bytes should give different ids');
});

// --- poller -------------------------------------------------------------

await atest('the poller only runs while waiting on the opponent', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = (fn) => { scheduled++; return scheduled; };
  globalThis.clearTimeout = () => {};

  const poller = createPoller({
    id: 'abc', getLastSeq: () => 0, onUpdate: () => {}, onError: () => {},
  });
  ok(!poller.running, 'starts idle');
  poller.start();
  ok(poller.running, 'start() schedules a tick');
  eq(scheduled, 1, 'exactly one timer');
  poller.start();
  eq(scheduled, 1, 'start() twice must not double-schedule');
  poller.stop();
  ok(!poller.running, 'stop() clears it');
  poller.dispose();
  poller.start();
  ok(!poller.running, 'a disposed poller cannot be restarted');

  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
});

// --- report -------------------------------------------------------------

out(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) out(`  FAIL  ${f}`);
if (failures.length) throw new Error(`${failures.length} test(s) failed`);
