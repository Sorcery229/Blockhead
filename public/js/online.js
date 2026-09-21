// Two-player games over Cloud Firestore's REST API.
//
// No Firebase SDK and no Cloud Functions: Functions require the paid Blaze
// plan, and the SDK would be a third dependency to load before the first move.
// A game is a single document holding one JSON string plus a sequence number,
// and each client polls for the other's move. At roughly 400 reads per game
// that sits comfortably inside the Spark free tier.
//
// The whole game state travels as one `state` string field. That keeps the
// Firestore value mapping trivial — no nested arrays or maps to encode — and
// means the document schema never has to track changes to the game model.

let config = null;

/** Loads the generated config, if it exists. Returns false when online play
 *  hasn't been set up, so the caller can hide the option rather than fail. */
export async function loadConfig() {
  try {
    const mod = await import('./firebase-config.js');
    const c = mod.FIREBASE_CONFIG;
    if (c && c.projectId && c.apiKey) {
      config = c;
      return true;
    }
  } catch {
    /* file absent — online play simply stays unavailable */
  }
  return false;
}

export const isConfigured = () => config !== null;

function docUrl(id, mask = false) {
  const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}`
    + `/databases/(default)/documents/games/${encodeURIComponent(id)}`;
  const params = [`key=${encodeURIComponent(config.apiKey)}`];
  if (mask) params.push('updateMask.fieldPaths=state', 'updateMask.fieldPaths=seq');
  return `${base}?${params.join('&')}`;
}

// --- document encoding --------------------------------------------------

/** Our two fields in Firestore's typed-value format. */
export function encodeDoc(state, seq) {
  return {
    fields: {
      state: { stringValue: JSON.stringify(state) },
      seq: { integerValue: String(seq) },
    },
  };
}

/** Inverse of encodeDoc. Returns null for a document we can't read. */
export function decodeDoc(doc) {
  const f = doc && doc.fields;
  if (!f || !f.state || typeof f.state.stringValue !== 'string') return null;
  let state;
  try {
    state = JSON.parse(f.state.stringValue);
  } catch {
    return null;
  }
  const seq = f.seq && f.seq.integerValue !== undefined ? Number(f.seq.integerValue) : 0;
  return { state, seq };
}

/** Short, unambiguous game id — no vowels, so it can't spell anything, and no
 *  0/O/1/l to misread when someone types it by hand. */
export function newGameId(randomBytes) {
  const alphabet = '23456789bcdfghjkmnpqrstvwxz';
  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(7));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// --- network ------------------------------------------------------------

export async function createGame(state) {
  const id = newGameId();
  const res = await fetch(docUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encodeDoc(state, 1)),
  });
  if (!res.ok) throw new Error(await describe(res));
  return { id, seq: 1 };
}

/** Returns {state, seq} or null when the game id doesn't exist. */
export async function fetchGame(id) {
  const res = await fetch(docUrl(id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await describe(res));
  return decodeDoc(await res.json());
}

export async function pushGame(id, state, seq) {
  const res = await fetch(docUrl(id, true), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encodeDoc(state, seq)),
  });
  if (!res.ok) throw new Error(await describe(res));
  return seq;
}

async function describe(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch { /* non-JSON error body */ }
  if (res.status === 403) {
    return 'Firestore refused the request (403). The security rules need to '
      + `allow access to games/*. ${detail}`;
  }
  if (res.status === 404 && detail.includes('database')) {
    return 'No Firestore database exists in this project yet — create one in '
      + 'the Firebase console (Build → Firestore Database → Create database).';
  }
  return `Firestore error ${res.status}. ${detail}`;
}

// --- polling ------------------------------------------------------------

/**
 * Polls while it's the opponent's turn and calls onUpdate when the stored
 * sequence number moves past what we last saw. Polling stops as soon as it
 * becomes our turn, so an idle game costs nothing.
 */
export function createPoller({ id, intervalMs = 2000, getLastSeq, onUpdate, onError }) {
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const snapshot = await fetchGame(id);
      if (snapshot && snapshot.seq > getLastSeq()) onUpdate(snapshot);
    } catch (err) {
      if (onError) onError(err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setTimeout(tick, intervalMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    dispose() {
      stopped = true;
      this.stop();
    },
    get running() { return timer !== null; },
  };
}
