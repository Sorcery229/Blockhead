// Word meanings, served from the app itself — no third-party API, no outbound
// link, nothing to wait on.
//
// Glosses come from Princeton WordNet 3.0 (see NOTICE), reduced to one short
// definition per word and split into 26 files by first letter. A lookup pulls
// one 70-200 KB file rather than a 9.5 MB dictionary, and `prefetch` warms the
// file for words already on screen so the panel is populated before you tap.
//
// Coverage is 66% of the lexicon. WordNet stores lemmas, so inflected forms
// were resolved at build time to their base ("poses" -> "pose") and carry that
// base so the panel can say where the definition came from. The remaining
// third are mostly rare ENABLE entries WordNet simply doesn't list.

const shards = new Map();     // letter -> Promise<Record<string, entry>>

function shard(letter) {
  if (!/^[a-z]$/.test(letter)) return Promise.resolve({});
  if (!shards.has(letter)) {
    shards.set(letter, fetch(`defs/${letter}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})));
  }
  return shards.get(letter);
}

/** Warm the file a word lives in, so the later lookup is synchronous-fast. */
export function prefetch(word) {
  if (typeof word === 'string' && word) shard(word[0].toLowerCase());
}

/**
 * @returns {Promise<{partOfSpeech: string, definition: string, base?: string}|null>}
 */
export async function lookup(word) {
  const key = String(word || '').toLowerCase();
  if (!key) return null;
  const data = await shard(key[0]);
  const entry = data[key];
  if (!entry) return null;
  return { partOfSpeech: entry[0], definition: entry[1], base: entry[2] };
}
