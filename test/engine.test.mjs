// Engine test suite. Runs under JavaScriptCore:
//   cd web && jsc -m test/engine.test.mjs
// or under Node:
//   cd web && node test/engine.test.mjs

import { WordDictionary, codes } from '../public/js/dictionary.js';
import {
  SIZE, CELLS, emptyGrid, placeWord, indexOf, areAdjacent,
  isConnectedPath, isPlayable, playableCells, wordAlong, isFull,
} from '../public/js/board.js';
import { search, bestMove, anyMoveExists } from '../public/js/movefinder.js';
import { BlockheadGame } from '../public/js/game.js';

// --- tiny harness -------------------------------------------------------

let passed = 0;
const failures = [];
const out = typeof print === 'function' ? print : console.log;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e && e.message ? e.message : e}`);
  }
}
function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

// --- fixtures -----------------------------------------------------------

// jsc exposes a global readFile(); under Node we import the real fs module.
const nodeFs = typeof readFile === 'function' ? null : await import('node:fs');
function readText(path) {
  return typeof readFile === 'function' ? readFile(path) : nodeFs.readFileSync(path, 'utf8');
}

const dict = new WordDictionary(
  readText('public/words.txt'),
  readText('public/starters5.txt'),
  readText('public/starters3.txt'),
);

/** "board" across the middle row of an otherwise empty 5x5 grid. */
const fixture = () => placeWord(emptyGrid(), 'board', 2);

function newGame() {
  const g = new BlockheadGame(dict, { opponent: 'human' });
  g.setPosition(fixture(), ['board']);
  return g;
}

/** Place C above the O, then trace C -> O -> B = "cob". */
function playCob(g) {
  const cell = indexOf(1, 1);
  g.placeLetter('c', cell);
  g.toggleInPath(cell);
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 0));
}

// --- board --------------------------------------------------------------

test('starting word centred in its row', () => {
  const g = fixture();
  eq(wordAlong(g, [0, 1, 2, 3, 4].map((c) => indexOf(2, c))), 'board');
  eq(g.filter((c) => c !== '').length, 5);
});

test('short starting word centred', () => {
  const g = placeWord(emptyGrid(), 'cat', 2);
  eq(g[indexOf(2, 0)], '');
  eq(g[indexOf(2, 1)], 'c');
  eq(g[indexOf(2, 3)], 't');
});

test('adjacency excludes diagonals', () => {
  ok(areAdjacent(indexOf(2, 2), indexOf(2, 3)));
  ok(areAdjacent(indexOf(2, 2), indexOf(1, 2)));
  ok(!areAdjacent(indexOf(2, 2), indexOf(1, 3)));
  ok(!areAdjacent(indexOf(2, 2), indexOf(2, 2)));
});

test('diagonal path rejected', () => {
  ok(!isConnectedPath(fixture(), [indexOf(2, 0), indexOf(1, 1)]));
});

test('path cannot reuse a cell', () => {
  ok(!isConnectedPath(fixture(), [indexOf(2, 0), indexOf(2, 1), indexOf(2, 0)]));
});

test('path cannot cross an empty cell', () => {
  ok(!isConnectedPath(fixture(), [indexOf(2, 0), indexOf(1, 0)]));
});

test('only cells touching letters are playable', () => {
  const g = fixture();
  ok(isPlayable(g, indexOf(1, 0)));
  ok(!isPlayable(g, indexOf(0, 0)));
  ok(!isPlayable(g, indexOf(2, 0)));
  eq(playableCells(g).length, 10);
});

// --- dictionary ---------------------------------------------------------

test('lexicon loaded', () => ok(dict.count > 100000, `only ${dict.count} words`));

test('membership', () => {
  ok(dict.contains(codes('cob')));
  ok(dict.contains(codes('board')));
  ok(!dict.contains(codes('xob')));
  ok(!dict.contains(codes('')));
});

test('prefix probe', () => {
  ok(dict.hasPrefix(codes('cob')));
  ok(dict.hasPrefix(codes('boar')));
  ok(!dict.hasPrefix(codes('zzq')));
});

test('every prefix of a real word probes true', () => {
  for (const w of ['aboard', 'hoarders', 'mavericks']) {
    for (let k = 1; k <= w.length; k++) {
      ok(dict.hasPrefix(codes(w.slice(0, k))), `prefix ${w.slice(0, k)}`);
    }
  }
});

test('starters are real words of the right length', () => {
  ok(dict.starters5.length > 0);
  ok(dict.starters3.length > 0);
  for (const w of dict.starters5.slice(0, 80)) {
    eq(w.length, 5, w);
    ok(dict.contains(codes(w)), `${w} missing from lexicon`);
  }
  for (const w of dict.starters3.slice(0, 80)) eq(w.length, 3, w);
});

// --- rules --------------------------------------------------------------

test('valid move scores one point per letter', () => {
  const g = newGame();
  playCob(g);
  eq(g.currentWord, 'cob');
  eq(g.validate(), null);
  ok(g.confirm());
  eq(g.score(0), 3);
  eq(g.current, 1, 'turn should pass');
  eq(g.grid[indexOf(1, 1)], 'c');
});

test('word must run through the new letter', () => {
  const g = newGame();
  g.placeLetter('c', indexOf(1, 1));
  g.toggleInPath(indexOf(2, 0));
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 2));
  eq(g.currentWord, 'boa');
  ok(g.validate() && g.validate().includes('run through'));
  ok(!g.confirm());
});

test('a word cannot be played twice', () => {
  const g = newGame();
  playCob(g);
  ok(g.confirm());
  g.setPosition(fixture(), ['board', 'cob']);
  playCob(g);
  ok(g.validate() && g.validate().includes('already been played'));
});

test('non-words rejected', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('x', cell);
  g.toggleInPath(cell);
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 0));
  eq(g.currentWord, 'xob');
  ok(g.validate().includes("isn't in the dictionary"));
});

test('too-short words rejected', () => {
  const g = newGame();
  const cell = indexOf(1, 0);
  g.placeLetter('a', cell);
  g.toggleInPath(cell);
  g.toggleInPath(indexOf(2, 0));
  eq(g.currentWord, 'ab');
  ok(g.validate().includes('at least 3'));
});

test('letters can only go on cells touching a letter', () => {
  const g = newGame();
  ok(!g.canPlaceLetter(indexOf(0, 0)));
  ok(!g.placeLetter('q', indexOf(0, 0)));
  ok(g.canPlaceLetter(indexOf(1, 0)));
});

test('non-adjacent tap does not extend the path', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('c', cell);
  g.toggleInPath(cell);
  g.toggleInPath(indexOf(2, 4));
  eq(g.selectedPath, [cell]);
});

test('tapping a selected cell unselects it and everything after it', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('c', cell);
  g.toggleInPath(cell);
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 0));
  eq(g.selectedPath.length, 3);

  // Tapping the middle cell drops it and the one traced after it.
  g.toggleInPath(indexOf(2, 1));
  eq(g.selectedPath, [cell]);

  // Tapping the only remaining cell clears the path entirely.
  g.toggleInPath(cell);
  eq(g.selectedPath, []);
});

test('a word made only of existing letters is rejected', () => {
  const g = newGame();
  ok(dict.contains(codes('boa')), 'boa is a real word already on the board');

  // Tracing is refused outright until a letter has been added — the path never
  // even forms, so an existing-letters-only word cannot be built.
  g.toggleInPath(indexOf(2, 0));
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 2));
  eq(g.selectedPath, [], 'no path may be traced before a letter is placed');
  ok(g.lastError && g.lastError.includes('Place a new letter'),
    `expected a "place a letter" error, got "${g.lastError}"`);
  ok(!g.confirm());

  // Same trace, but with a letter staged elsewhere: still rejected, because
  // the path has to run through the new letter.
  g.placeLetter('c', indexOf(1, 1));
  g.toggleInPath(indexOf(2, 0));
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(indexOf(2, 2));
  ok(g.validate().includes('run through'));
  ok(!g.confirm());
});

test('tapping the new letter cycles select, deselect, remove', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  eq(g.selectedPath, [], 'placing a letter must not pre-select it');
  eq(g.workingGrid[cell], 't', 'the letter shows on the board straight away');

  g.tapCell(cell);                       // 1: select
  eq(g.selectedPath, [cell]);

  g.tapCell(cell);                       // 2: deselect, letter stays
  eq(g.selectedPath, []);
  eq(g.pendingLetter, 't');
  eq(g.workingGrid[cell], 't');

  g.tapCell(cell);                       // 3: remove the letter
  eq(g.pendingLetter, null);
  eq(g.pendingCell, null);
  eq(g.workingGrid[cell], '');
  eq(g.grid[cell], '', 'the board itself must be untouched');
});

test('deselecting the new letter drops the rest of the path with it', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  g.tapCell(indexOf(2, 0));              // b
  g.tapCell(indexOf(2, 1));              // o
  g.tapCell(cell);                       // t  -> "bot"
  eq(g.currentWord, 'bot');
  g.tapCell(cell);                       // deselect the new letter
  eq(g.currentWord, 'bo', 'the traced prefix survives');
  eq(g.pendingLetter, 't', 'the letter is still on the board');
});

test('tapping another cell restarts the three-tap cycle', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  g.tapCell(cell);                       // select
  g.tapCell(cell);                       // deselect — next tap would remove
  g.tapCell(indexOf(2, 1));              // but we touch another cell instead
  g.tapCell(cell);                       // so this selects again, not removes
  ok(g.pendingLetter === 't', 'letter should still be placed');
  ok(g.selectedPath.includes(cell), 'new letter should be back in the path');
});

// --- unknown words, challenged ------------------------------------------

/** Stages the legal-but-unknown word "XOB": X placed at (1,1), traced X-O-B. */
function stageUnknownWord(g) {
  const cell = indexOf(1, 1);
  g.placeLetter('x', cell);
  g.tapCell(cell);
  g.tapCell(indexOf(2, 1));
  g.tapCell(indexOf(2, 0));
  return cell;
}

test('an unknown word is offered for challenge rather than refused', () => {
  const g = newGame();
  stageUnknownWord(g);
  eq(g.currentWord, 'xob');
  ok(!g.inDictionary, 'xob should not be in the lexicon');
  eq(g.validateShape(), null, 'the move is geometrically legal');
  const result = g.submit();
  eq(result.outcome, 'challenge');
  eq(result.word, 'xob');
  eq(g.score(0), 0, 'nothing is awarded yet');
  eq(g.current, 0, 'the turn has not passed');
});

test('an accepted claim scores and passes the turn', () => {
  const g = newGame();
  const cell = stageUnknownWord(g);
  g.submit();
  ok(g.claimWord());
  eq(g.pendingClaim.word, 'xob');
  eq(g.pendingClaim.by, 0);

  ok(g.resolveClaim(true));
  eq(g.score(0), 3, 'three letters, three points');
  eq(g.current, 1, 'turn passes');
  eq(g.grid[cell], 'x', 'the letter is now on the board');
  eq(g.players[0].words[0].challenged, true, 'recorded as allowed by agreement');
  ok(g.usedWords.has('xob'), 'and cannot be played again');
  eq(g.pendingClaim, null);
});

test('a refused claim scores nothing and keeps the turn', () => {
  const g = newGame();
  const cell = stageUnknownWord(g);
  g.submit();
  g.claimWord();

  eq(g.resolveClaim(false), false);
  eq(g.score(0), 0);
  eq(g.current, 0, 'the player must try something else');
  eq(g.grid[cell], '', 'the board is untouched');
  eq(g.pendingClaim, null);
  ok(g.lastError && g.lastError.includes("didn't accept"));
  eq(g.pendingLetter, null, 'the staged letter is cleared');
});

test('challenging can be switched off', () => {
  const g = newGame();
  g.settings.allowChallenge = false;
  stageUnknownWord(g);
  const result = g.submit();
  eq(result.outcome, 'error');
  ok(result.message.includes("isn't in the dictionary"));
  eq(g.score(0), 0);
});

test('a known word still commits directly, with no challenge', () => {
  const g = newGame();
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  g.tapCell(indexOf(2, 0));
  g.tapCell(indexOf(2, 1));
  g.tapCell(cell);
  const result = g.submit();
  eq(result.outcome, 'played');
  eq(result.word, 'bot');
  eq(g.score(0), 3);
  eq(g.players[0].words[0].challenged, false);
  eq(g.pendingClaim, null);
});

test('submit still refuses illegal shapes before asking about the word', () => {
  const g = newGame();
  // A letter placed but the path misses it.
  g.placeLetter('x', indexOf(1, 1));
  g.tapCell(indexOf(2, 0));
  g.tapCell(indexOf(2, 1));
  g.tapCell(indexOf(2, 2));
  const result = g.submit();
  eq(result.outcome, 'error');
  ok(result.message.includes('run through'));
});

test('a pending claim survives serialisation', () => {
  const g = newGame();
  stageUnknownWord(g);
  g.submit();
  g.claimWord();

  const b = new BlockheadGame(dict, { opponent: 'human' }).loadFrom(g.toJSON());
  eq(b.pendingClaim.word, 'xob');
  eq(b.pendingClaim.by, 0);
  ok(b.resolveClaim(true), 'the opponent can accept it on the other device');
  eq(b.score(0), 3);
});

test('timeout skip policy passes the turn without points', () => {
  const g = newGame();
  g.settings.turnSeconds = 5;
  g.settings.timeoutPolicy = 'skipTurn';
  g.handleTimeout();
  eq(g.current, 1);
  eq(g.status, 'playing');
  eq(g.score(0), 0);
});

test('timeout lose policy ends the game', () => {
  const g = newGame();
  g.settings.timeoutPolicy = 'loseGame';
  g.handleTimeout();
  eq(g.status, 'finished');
  eq(g.winner, 1);
});

test('resigning loses the game', () => {
  const g = newGame();
  g.resign();
  eq(g.status, 'finished');
  eq(g.winner, 1);
});

// --- move generator -----------------------------------------------------

test('finds legal moves and all of them are valid', () => {
  const base = fixture();
  const moves = search(dict, base, new Set(['board']), { minLength: 3, budgetMs: 20000 });
  ok(moves.length > 0, 'no moves found');
  for (const m of moves) {
    const g = base.slice();
    ok(g[m.cell] === '', `${m.word}: new letter not on an empty cell`);
    g[m.cell] = m.letter;
    ok(isConnectedPath(g, m.path), `${m.word}: broken path`);
    ok(m.path.includes(m.cell), `${m.word}: misses the new letter`);
    eq(wordAlong(g, m.path), m.word, m.word);
    ok(dict.contains(codes(m.word)), `${m.word} not in lexicon`);
    ok(m.word.length >= 3, m.word);
  }
});

test('the new letter need not be the first letter of the word', () => {
  const moves = search(dict, fixture(), new Set(['board']), { minLength: 3, budgetMs: 20000 });
  const positions = new Set(moves.map((m) => m.path.indexOf(m.cell)));
  ok(positions.has(0), 'expected words starting with the new letter');
  ok([...positions].some((p) => p > 0), 'expected words where the new letter is not first');
  ok(moves.some((m) => m.path.indexOf(m.cell) === m.path.length - 1),
    'expected at least one word ending with the new letter');
  // Note: on this opening the new letter can never be *interior*. Row 2 is the
  // only filled row, so any playable cell has exactly one filled neighbour and
  // must be an endpoint of the path. The interior case needs the position below.
});

test('the new letter can sit in the middle of the word', () => {
  // "board" across row 2, plus an S above the B. Now the cell at (1,1) has two
  // filled neighbours — S to its left and O below — so a path can run through it.
  const g = placeWord(emptyGrid(), 'board', 2);
  g[indexOf(1, 0)] = 's';

  const moves = search(dict, g, new Set(['board']), { minLength: 3, budgetMs: 20000 });
  const middle = moves.filter((m) => {
    const at = m.path.indexOf(m.cell);
    return at > 0 && at < m.path.length - 1;
  });
  ok(middle.length > 0, 'expected words with the new letter in the middle');

  // S → N → O → B, with the new N second of four.
  const game = new BlockheadGame(dict, { opponent: 'human' });
  game.setPosition(g, ['board']);
  const cell = indexOf(1, 1);
  game.placeLetter('n', cell);
  game.toggleInPath(indexOf(1, 0));
  game.toggleInPath(cell);
  game.toggleInPath(indexOf(2, 1));
  game.toggleInPath(indexOf(2, 0));
  eq(game.currentWord, 'snob');
  eq(game.validate(), null);
  ok(game.confirm());
  eq(game.score(0), 4);
});

test('a word ending with the new letter validates through the engine', () => {
  const g = new BlockheadGame(dict, { opponent: 'human' });
  g.setPosition(fixture(), ['board']);
  const cell = indexOf(1, 1);
  g.placeLetter('t', cell);
  g.toggleInPath(indexOf(2, 0));
  g.toggleInPath(indexOf(2, 1));
  g.toggleInPath(cell);
  eq(g.currentWord, 'bot');
  eq(g.validate(), null);
  ok(g.confirm());
  eq(g.score(0), 3);
});

test('the opening finds "aboard"', () => {
  const moves = search(dict, fixture(), new Set(['board']), { minLength: 3, budgetMs: 20000 });
  ok(moves.some((m) => m.word === 'aboard'), 'aboard should be reachable');
});

test('hard plays at least as long as easy', () => {
  const base = fixture();
  const used = new Set(['board']);
  for (let i = 0; i < 5; i++) {
    const hard = bestMove(dict, base, used, 3, 'hard');
    const easy = bestMove(dict, base, used, 3, 'easy');
    ok(hard && easy);
    ok(hard.word.length >= easy.word.length, `${hard.word} vs ${easy.word}`);
  }
});

test('used words are never suggested', () => {
  const base = fixture();
  const all = search(dict, base, new Set(['board']), { minLength: 3, budgetMs: 20000 });
  const banned = new Set(['board', all[0].word]);
  const again = search(dict, base, banned, { minLength: 3, budgetMs: 20000 });
  ok(!again.some((m) => banned.has(m.word)));
});

test('a full board has no moves', () => {
  const g = new Array(CELLS).fill('q');
  ok(isFull(g));
  ok(!anyMoveExists(dict, g, new Set(), 3));
});

// --- integration --------------------------------------------------------

test('a hard-vs-hard game fills the board and terminates', () => {
  const g = new BlockheadGame(dict, { opponent: 'ai', difficulty: 'hard' });
  g.setPosition(fixture(), ['board']);
  g.players[0].isComputer = true;
  g.players[1].isComputer = true;

  let turns = 0;
  while (g.status === 'playing' && turns < 40) {
    const move = g.playComputerMove();
    if (!move) break;
    turns++;
    ok(dict.contains(codes(move.word)), `played non-word ${move.word}`);
  }
  eq(g.status, 'finished');
  eq(turns, 20, 'a 5-letter opening leaves exactly 20 empty cells');
  ok(isFull(g.grid), 'board should be full');
  ok(g.score(0) > 30 && g.score(1) > 30, `lopsided: ${g.score(0)}-${g.score(1)}`);
});

// --- report -------------------------------------------------------------

out(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) out(`  FAIL  ${f}`);
if (failures.length) throw new Error(`${failures.length} test(s) failed`);
