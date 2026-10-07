/* Minimal in-memory stand-in for firebase-firestore.js, serving the demo
 * dataset. Reads resolve against window.EVERANE_DEMO; every write is a no-op,
 * which is what makes the demo uneditable without touching page code.
 *
 * Paths are modelled as "users/<uid>", "users/<uid>/medications/<id>", etc.
 */
const DEMO = () => window.EVERANE_DEMO || { profile: {}, medications: {}, doctorEdits: {}, groups: {} };

function warnWrite(op, path) {
  console.info(`[demo] ${op} ignored (read-only demo): ${path}`);
}

function segments(parent, rest) {
  const base = parent && parent.__path ? parent.__path.slice() : [];
  return base.concat(rest.filter(s => typeof s === 'string'));
}

export function getFirestore() { return { __db: true }; }
export function initializeFirestore() { return { __db: true }; }

export function collection(dbOrRef, ...rest) {
  const path = (dbOrRef && dbOrRef.__path) ? segments(dbOrRef, rest) : rest.filter(s => typeof s === 'string');
  return { __path: path, __type: 'collection' };
}

export function doc(dbOrRef, ...rest) {
  const path = (dbOrRef && dbOrRef.__path) ? segments(dbOrRef, rest) : rest.filter(s => typeof s === 'string');
  if (path.length % 2 === 1) path.push('auto-' + Math.random().toString(36).slice(2, 9));
  return { __path: path, __type: 'doc', id: path[path.length - 1] };
}

function resolveDoc(path) {
  const d = DEMO();
  if (path.length === 2 && path[0] === 'users') return d.profile;
  if (path.length === 4 && path[1] === d.uid) {
    const bucket = { medications: d.medications, doctorEdits: d.doctorEdits, groups: d.groups }[path[2]];
    return bucket ? bucket[path[3]] : undefined;
  }
  return undefined;
}

function resolveCollection(path) {
  const d = DEMO();
  if (path.length === 3 && path[0] === 'users') {
    const bucket = { medications: d.medications, doctorEdits: d.doctorEdits, groups: d.groups }[path[2]];
    return bucket || {};
  }
  if (path.length === 1 && path[0] === 'users') return { [d.uid]: d.profile };
  return {};
}

function snapFor(ref, data) {
  return {
    id: ref.id || (ref.__path ? ref.__path[ref.__path.length - 1] : ''),
    ref,
    exists: () => data !== undefined && data !== null,
    data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
    get: (f) => (data ? data[f] : undefined),
  };
}

export async function getDoc(ref) { return snapFor(ref, resolveDoc(ref.__path || [])); }
export async function getDocFromServer(ref) { return getDoc(ref); }

function querySnap(ref) {
  const map = resolveCollection(ref.__path || []);
  const docs = Object.keys(map).map(id =>
    snapFor({ __path: (ref.__path || []).concat(id), __type: 'doc', id }, map[id]));
  return {
    docs, size: docs.length, empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
  };
}

export async function getDocs(ref) { return querySnap(ref.__target || ref); }
export async function getDocsFromServer(ref) { return getDocs(ref); }

export function onSnapshot(ref, next) {
  const cb = typeof next === 'function' ? next : (next && next.next);
  const target = ref.__target || ref;
  setTimeout(() => {
    try { cb(target.__type === 'doc' ? snapFor(target, resolveDoc(target.__path)) : querySnap(target)); }
    catch (e) { console.warn('[demo] onSnapshot handler threw', e); }
  }, 0);
  return () => {};
}

// Queries: the demo collections are tiny, so filters are a pass-through.
export function query(ref, ...clauses) { return { ...ref, __target: ref, __clauses: clauses }; }
export function where() { return { __clause: 'where' }; }
export function orderBy() { return { __clause: 'orderBy' }; }
export function limit() { return { __clause: 'limit' }; }
export function startAfter() { return { __clause: 'startAfter' }; }

export async function setDoc(ref) { warnWrite('setDoc', (ref.__path || []).join('/')); }
export async function addDoc(ref) { warnWrite('addDoc', (ref.__path || []).join('/')); return doc(ref, 'demo-new'); }
export async function updateDoc(ref) { warnWrite('updateDoc', (ref.__path || []).join('/')); }
export async function deleteDoc(ref) { warnWrite('deleteDoc', (ref.__path || []).join('/')); }
export function deleteField() { return { __delete: true }; }
export function serverTimestamp() { return new Date().toISOString(); }
export function increment(n) { return n; }
export function arrayUnion(...v) { return v; }
export function arrayRemove(...v) { return v; }
export async function writeBatch() {
  return { set: () => {}, update: () => {}, delete: () => {}, commit: async () => warnWrite('batch', '') };
}
export async function runTransaction(_db, fn) {
  return fn({ get: async (r) => getDoc(r), set: () => {}, update: () => {}, delete: () => {} });
}
export class Timestamp {
  constructor(seconds) { this.seconds = seconds; }
  static now() { return new Timestamp(Math.floor(Date.now() / 1000)); }
  static fromDate(d) { return new Timestamp(Math.floor(d.getTime() / 1000)); }
  toDate() { return new Date(this.seconds * 1000); }
  toMillis() { return this.seconds * 1000; }
}
export function enableIndexedDbPersistence() { return Promise.resolve(); }
export function connectFirestoreEmulator() {}
