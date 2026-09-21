// Exhaustive move generator.
//
// For every empty cell touching a letter, and every letter a-z, walk the grid
// depth-first collecting words that pass through the new cell. Tractable only
// because each partial path is tested against the lexicon's prefix index and
// abandoned as soon as no word can extend it.

import { CELLS, NEIGHBORS, isPlayable } from './board.js';

const A_CODE = 97;
const Z_CODE = 122;

export const DIFFICULTY_FRACTION = { easy: [0.0, 0.3], medium: [0.4, 0.7], hard: [1.0, 1.0] };

/**
 * @returns {{cell:number, letter:string, path:number[], word:string}[]}
 */
export function search(dict, grid, usedWords, {
  minLength = 3,
  firstOnly = false,
  budgetMs = 3000,
} = {}) {
  const work = grid.slice();
  const results = new Map();
  const deadline = Date.now() + budgetMs;

  let stop = false;
  let probes = 0;
  let newIndex = 0;
  let newLetter = 'a';

  const prefix = [];
  const path = [];
  let visited = 0;

  function dfs(i, includesNew) {
    if (stop) return;
    if ((++probes & 0x3ff) === 0 && Date.now() > deadline) {
      stop = true;
      return;
    }

    prefix.push(work[i].charCodeAt(0));
    path.push(i);
    visited |= 1 << i;

    if (dict.hasPrefix(prefix)) {
      const hitNew = includesNew || i === newIndex;
      if (hitNew && prefix.length >= minLength && dict.contains(prefix)) {
        let word = '';
        for (const p of path) word += work[p];
        if (!usedWords.has(word) && !results.has(word)) {
          results.set(word, { cell: newIndex, letter: newLetter, path: path.slice(), word });
          if (firstOnly) stop = true;
        }
      }
      if (!stop) {
        const nbrs = NEIGHBORS[i];
        for (let k = 0; k < nbrs.length; k++) {
          const j = nbrs[k];
          if (work[j] !== '' && (visited & (1 << j)) === 0) {
            dfs(j, hitNew);
            if (stop) break;
          }
        }
      }
    }

    visited &= ~(1 << i);
    prefix.pop();
    path.pop();
  }

  const candidates = [];
  for (let i = 0; i < CELLS; i++) if (isPlayable(work, i)) candidates.push(i);

  outer: for (const p of candidates) {
    for (let code = A_CODE; code <= Z_CODE; code++) {
      work[p] = String.fromCharCode(code);
      newIndex = p;
      newLetter = work[p];

      for (let s = 0; s < CELLS; s++) {
        if (work[s] !== '') {
          dfs(s, false);
          if (stop) break;
        }
      }
      work[p] = '';
      if (stop) break outer;
    }
  }

  return [...results.values()];
}

export function anyMoveExists(dict, grid, usedWords, minLength = 3) {
  return search(dict, grid, usedWords, { minLength, firstOnly: true, budgetMs: 6000 }).length > 0;
}

/**
 * Selection interpolates over the span of available word *lengths*, not over
 * the rank of the candidate list. Rank doesn't separate the levels: three-letter
 * words dominate the candidate set so heavily that a rank percentile put easy
 * and medium at mean lengths of 3.0 and 3.4 — effectively one opponent.
 */
export function bestMove(dict, grid, usedWords, minLength, difficulty) {
  const moves = search(dict, grid, usedWords, { minLength });
  if (!moves.length) return null;

  const lengths = [...new Set(moves.map((m) => m.word.length))].sort((a, b) => a - b);
  const shortest = lengths[0];
  const longest = lengths[lengths.length - 1];

  const [lo, hi] = DIFFICULTY_FRACTION[difficulty] ?? DIFFICULTY_FRACTION.medium;
  const fraction = lo + Math.random() * (hi - lo);
  const target = shortest + fraction * (longest - shortest);

  let chosen = lengths[0];
  for (const L of lengths) {
    if (Math.abs(L - target) < Math.abs(chosen - target)) chosen = L;
  }

  const pool = moves.filter((m) => m.word.length === chosen);
  return pool[Math.floor(Math.random() * pool.length)];
}
