// The playing field. Cells are addressed by a flat index; adjacency is
// orthogonal only — diagonals are never connected.

export const SIZE = 5;
export const CELLS = SIZE * SIZE;

export const NEIGHBORS = (() => {
  const table = [];
  for (let i = 0; i < CELLS; i++) {
    const r = (i / SIZE) | 0;
    const c = i % SIZE;
    const list = [];
    if (r > 0) list.push(i - SIZE);
    if (r < SIZE - 1) list.push(i + SIZE);
    if (c > 0) list.push(i - 1);
    if (c < SIZE - 1) list.push(i + 1);
    table.push(list);
  }
  return table;
})();

export const rowOf = (i) => (i / SIZE) | 0;
export const colOf = (i) => i % SIZE;
export const indexOf = (r, c) => r * SIZE + c;

export function areAdjacent(a, b) {
  return NEIGHBORS[a].includes(b);
}

export function emptyGrid() {
  return new Array(CELLS).fill('');
}

/** Writes `word` horizontally, centred, into `row`. */
export function placeWord(grid, word, row) {
  const w = word.toLowerCase();
  const startCol = Math.floor((SIZE - w.length) / 2);
  for (let k = 0; k < w.length; k++) {
    grid[indexOf(row, startCol + k)] = w[k];
  }
  return grid;
}

export function isFull(grid) {
  return grid.every((c) => c !== '');
}

/** A letter is only placeable on an empty cell that touches an existing one. */
export function isPlayable(grid, i) {
  return grid[i] === '' && NEIGHBORS[i].some((j) => grid[j] !== '');
}

export function playableCells(grid) {
  const out = [];
  for (let i = 0; i < CELLS; i++) if (isPlayable(grid, i)) out.push(i);
  return out;
}

/** Every step orthogonally adjacent, no cell repeated, every cell filled. */
export function isConnectedPath(grid, path) {
  if (!path.length) return false;
  if (new Set(path).size !== path.length) return false;
  for (const i of path) if (grid[i] === '') return false;
  for (let k = 1; k < path.length; k++) {
    if (!areAdjacent(path[k - 1], path[k])) return false;
  }
  return true;
}

export function wordAlong(grid, path) {
  let s = '';
  for (const i of path) s += grid[i];
  return s;
}
