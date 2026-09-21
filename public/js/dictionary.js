// Lexicon lookup over a sorted, newline-separated ASCII word list.
//
// The word list is kept as the original string plus an offset table rather
// than as an array of 172k JavaScript strings — same approach as the Swift
// build. Measured under JavaScriptCore: the offset table costs 0.86 MB on top
// of the 1.7 MB source it retains (~2.6 MB total), against 6.59 MB for
// `text.split('\n')`. Note this is a memory trade, not a speed one — building
// the offset table takes ~12 ms versus ~8 ms for the naive split.

export class WordDictionary {
  /**
   * @param {string} text  sorted word list, one lowercase word per line
   * @param {string} starters5  newline-separated 5-letter opening words
   * @param {string} starters3  newline-separated 3-letter opening words
   */
  constructor(text, starters5 = '', starters3 = '') {
    this.text = text;

    // One pass to count, a second to fill — avoids growing a normal array.
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) count++;
    }
    if (text.length && text.charCodeAt(text.length - 1) !== 10) count++;

    this.starts = new Int32Array(count);
    this.lens = new Uint8Array(count);

    let n = 0;
    let begin = 0;
    for (let i = 0; i <= text.length; i++) {
      const code = i < text.length ? text.charCodeAt(i) : 10;
      if (code === 10) {
        const len = i - begin;
        if (len > 0) {
          this.starts[n] = begin;
          this.lens[n] = Math.min(len, 255);
          n++;
        }
        begin = i + 1;
      }
    }
    this.count = n;

    this.starters5 = starters5.split('\n').filter((w) => w.length === 5);
    this.starters3 = starters3.split('\n').filter((w) => w.length === 3);
  }

  /** Lexicographic comparison of entry `i` against the char codes in `query`. */
  #compare(i, query) {
    const start = this.starts[i];
    const len = this.lens[i];
    const n = Math.min(len, query.length);
    for (let k = 0; k < n; k++) {
      const a = this.text.charCodeAt(start + k);
      const b = query[k];
      if (a !== b) return a < b ? -1 : 1;
    }
    if (len === query.length) return 0;
    return len < query.length ? -1 : 1;
  }

  /** Compares only the first `query.length` characters. */
  #comparePrefix(i, query) {
    const start = this.starts[i];
    const len = this.lens[i];
    const n = Math.min(len, query.length);
    for (let k = 0; k < n; k++) {
      const a = this.text.charCodeAt(start + k);
      const b = query[k];
      if (a !== b) return a < b ? -1 : 1;
    }
    // Entry shorter than the prefix but matching so far: it sorts first.
    return len < query.length ? -1 : 0;
  }

  /** @param {number[]|Uint8Array} query lowercase char codes */
  contains(query) {
    if (!query.length) return false;
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.#compare(mid, query);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** True if any word starts with `query`. This is the search's pruning test. */
  hasPrefix(query) {
    if (!query.length) return true;
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.#comparePrefix(mid, query);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  containsWord(word) {
    return this.contains(codes(word.toLowerCase()));
  }

  randomStarter(length) {
    const pool = length === 3 ? this.starters3 : this.starters5;
    if (!pool.length) return length === 3 ? 'cat' : 'board';
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

export function codes(s) {
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
