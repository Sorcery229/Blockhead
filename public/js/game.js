// Game state, rule validation and turn flow. No DOM access — this module runs
// unchanged under a bare JS engine, which is how the test suite exercises it.

import {
  CELLS, SIZE, emptyGrid, placeWord, isFull, isPlayable,
  isConnectedPath, wordAlong, areAdjacent,
} from './board.js';
import { codes } from './dictionary.js';
import { bestMove, anyMoveExists } from './movefinder.js';

export const START_MODES = {
  standard: 'One 5-letter word',
  short: 'Short word (3 letters)',
  twoWords: 'Two starting words',
};

export const TIMEOUT_POLICIES = {
  skipTurn: 'Turn is skipped (no points)',
  loseGame: 'Player loses the game',
};

export const TIME_OPTIONS = [null, 5, 10, 15, 30, 60, 120, 300];

export const DEFAULT_SETTINGS = {
  startMode: 'standard',
  opponent: 'ai',        // 'ai' | 'human'
  difficulty: 'medium',
  turnSeconds: null,
  timeoutPolicy: 'skipTurn',
  minimumWordLength: 3,
};

export const ERRORS = {
  noLetterPlaced: 'Place a new letter on the board first.',
  pathMissesNewLetter: 'The word has to run through the letter you just placed.',
  pathNotConnected: 'Letters must connect up, down, left or right — not diagonally.',
  pathTooShort: (n) => `Words must be at least ${n} letters.`,
  alreadyPlayed: (w) => `"${w.toUpperCase()}" has already been played.`,
  notInDictionary: (w) => `"${w.toUpperCase()}" isn't in the dictionary.`,
};

export class BaldaGame {
  constructor(dict, settings = {}) {
    this.dict = dict;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.reset();
  }

  reset(settings) {
    if (settings) this.settings = { ...this.settings, ...settings };
    this.grid = emptyGrid();
    this.usedWords = new Set();
    this.startingWords = [];
    this.history = [];
    this.players = [
      { name: 'You', isComputer: false, words: [] },
      {
        name: this.settings.opponent === 'ai' ? 'Computer' : 'Player 2',
        isComputer: this.settings.opponent === 'ai',
        words: [],
      },
    ];
    this.current = 0;
    this.status = 'playing';       // 'playing' | 'finished'
    this.winner = null;            // index, or null for a draw
    this.endReason = '';
    this.clearPending();
    this.seed();
  }

  seed() {
    const grid = emptyGrid();
    if (this.settings.startMode === 'short') {
      const w = this.dict.randomStarter(3);
      placeWord(grid, w, 2);
      this.startingWords = [w];
    } else if (this.settings.startMode === 'twoWords') {
      const a = this.dict.randomStarter(5);
      let b = this.dict.randomStarter(5);
      let guard = 0;
      while (b === a && guard++ < 20) b = this.dict.randomStarter(5);
      placeWord(grid, a, 0);
      placeWord(grid, b, 4);
      this.startingWords = [a, b];
    } else {
      const w = this.dict.randomStarter(5);
      placeWord(grid, w, 2);
      this.startingWords = [w];
    }
    this.grid = grid;
    this.usedWords = new Set(this.startingWords);
  }

  /** "Change starting word" — only legal before the first move. */
  reseed() {
    if (this.history.length) return false;
    this.clearPending();
    this.seed();
    return true;
  }

  // --- composing a move -------------------------------------------------

  clearPending() {
    this.pendingCell = null;
    this.pendingLetter = null;
    this.pendingArmed = false;
    this.selectedPath = [];
    this.lastError = null;
    this.highlightPath = [];
  }

  /** The grid as it would look with the pending letter applied. */
  get workingGrid() {
    if (this.pendingCell === null) return this.grid;
    const g = this.grid.slice();
    g[this.pendingCell] = this.pendingLetter;
    return g;
  }

  canPlaceLetter(i) {
    return this.status === 'playing' && isPlayable(this.grid, i);
  }

  placeLetter(letter, i) {
    if (!this.canPlaceLetter(i)) return false;
    this.pendingCell = i;
    this.pendingLetter = letter.toLowerCase();
    this.selectedPath = [];
    this.pendingArmed = true;
    this.lastError = null;
    return true;
  }

  /** Takes the staged letter back off the board, along with any part of the
   *  path that depended on it. */
  removePendingLetter() {
    if (this.pendingCell === null) return;
    const at = this.selectedPath.indexOf(this.pendingCell);
    if (at !== -1) this.selectedPath = this.selectedPath.slice(0, at);
    this.pendingCell = null;
    this.pendingLetter = null;
    this.pendingArmed = false;
    this.lastError = null;
  }

  /**
   * Single entry point for tapping a cell that has a letter on it.
   *
   * The letter you just placed cycles through three states on consecutive
   * taps, which replaces the old Cancel button:
   *   1. select it as part of the word
   *   2. deselect it — the letter stays on the board
   *   3. remove the letter from the board entirely
   * Tapping any other cell resets that cycle, so the three states only apply
   * to taps in a row on the new letter.
   */
  tapCell(i) {
    if (this.status !== 'playing') return;
    if (this.workingGrid[i] === '') return;

    if (i !== this.pendingCell) {
      this.pendingArmed = true;
      this.toggleInPath(i);
      return;
    }

    const at = this.selectedPath.indexOf(i);
    if (at !== -1) {
      // Second tap: drop it, and anything traced after it, but keep the letter.
      this.selectedPath = this.selectedPath.slice(0, at);
      this.pendingArmed = false;
      this.lastError = null;
      return;
    }

    if (this.pendingArmed) {
      this.toggleInPath(i);       // first tap
      return;
    }

    this.removePendingLetter();   // third tap
  }

  /** Tap/drag handler: append, backtrack, or rewind to an earlier cell. */
  toggleInPath(i) {
    if (this.pendingLetter === null) {
      this.lastError = ERRORS.noLetterPlaced;
      return;
    }
    const g = this.workingGrid;
    if (g[i] === '') return;

    const at = this.selectedPath.indexOf(i);
    if (at !== -1) {
      this.selectedPath = this.selectedPath.slice(0, at + 1);
      return;
    }
    const last = this.selectedPath[this.selectedPath.length - 1];
    if (last !== undefined && !areAdjacent(last, i)) return;
    this.selectedPath.push(i);
    this.lastError = null;
  }

  get currentWord() {
    return wordAlong(this.workingGrid, this.selectedPath);
  }

  validate() {
    if (this.pendingCell === null) return ERRORS.noLetterPlaced;
    const g = this.workingGrid;
    if (!isConnectedPath(g, this.selectedPath)) return ERRORS.pathNotConnected;
    if (!this.selectedPath.includes(this.pendingCell)) return ERRORS.pathMissesNewLetter;
    const word = wordAlong(g, this.selectedPath);
    if (word.length < this.settings.minimumWordLength) {
      return ERRORS.pathTooShort(this.settings.minimumWordLength);
    }
    if (this.usedWords.has(word)) return ERRORS.alreadyPlayed(word);
    if (!this.dict.contains(codes(word))) return ERRORS.notInDictionary(word);
    return null;
  }

  get canConfirm() {
    return this.status === 'playing' && this.validate() === null;
  }

  confirm() {
    const error = this.validate();
    if (error) {
      this.lastError = error;
      return false;
    }
    const g = this.workingGrid;
    const word = wordAlong(g, this.selectedPath);
    const played = {
      word,
      path: this.selectedPath.slice(),
      cell: this.pendingCell,
      letter: this.pendingLetter,
      player: this.current,
      points: word.length,
    };
    this.grid = g;
    this.usedWords.add(word);
    this.players[this.current].words.push(played);
    this.history.push(played);
    this.clearPending();
    this.advance();
    return true;
  }

  // --- turn flow --------------------------------------------------------

  advance() {
    if (isFull(this.grid)) {
      this.finishByScore('The board is full.');
      return;
    }
    this.current = 1 - this.current;
  }

  score(i) {
    return this.players[i].words.reduce((t, w) => t + w.points, 0);
  }

  finishByScore(reason) {
    const a = this.score(0);
    const b = this.score(1);
    this.status = 'finished';
    if (a === b) {
      this.winner = null;
      this.endReason = `${reason} Scores are level.`;
    } else {
      this.winner = a > b ? 0 : 1;
      this.endReason = reason;
    }
  }

  /** The player states they can't move: by the default rules, they lose. */
  resign() {
    const loser = this.current;
    this.status = 'finished';
    this.winner = 1 - loser;
    this.endReason = `${this.players[loser].name} couldn't find a word.`;
  }

  handleTimeout() {
    if (this.status !== 'playing') return;
    this.clearPending();
    if (this.settings.timeoutPolicy === 'loseGame') {
      const loser = this.current;
      this.status = 'finished';
      this.winner = 1 - loser;
      this.endReason = `${this.players[loser].name} ran out of time.`;
    } else {
      this.advance();
    }
  }

  get isComputerTurn() {
    return this.status === 'playing' && this.players[this.current].isComputer;
  }

  /** Runs the search and applies the result. Returns the move, or null. */
  playComputerMove() {
    if (!this.isComputerTurn) return null;
    const move = bestMove(
      this.dict, this.grid, this.usedWords,
      this.settings.minimumWordLength, this.settings.difficulty,
    );
    if (!move) {
      this.status = 'finished';
      this.winner = 1 - this.current;
      this.endReason = `${this.players[this.current].name} couldn't find a word.`;
      return null;
    }
    this.grid[move.cell] = move.letter;
    this.usedWords.add(move.word);
    const played = {
      word: move.word,
      path: move.path,
      cell: move.cell,
      letter: move.letter,
      player: this.current,
      points: move.word.length,
    };
    this.players[this.current].words.push(played);
    this.history.push(played);
    this.advance();
    return played;
  }

  anyMoveLeft() {
    return anyMoveExists(this.dict, this.grid, this.usedWords, this.settings.minimumWordLength);
  }

  /** Test hook: install a fixed position. */
  setPosition(grid, usedWords) {
    this.grid = grid.slice();
    this.usedWords = new Set(usedWords);
    this.startingWords = [...usedWords];
    this.history = [];
    this.players[0].words = [];
    this.players[1].words = [];
    this.current = 0;
    this.status = 'playing';
    this.winner = null;
    this.endReason = '';
    this.clearPending();
  }
}

export { SIZE, CELLS };
