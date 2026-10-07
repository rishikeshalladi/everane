/* Stand-in for firebase-functions.js (client callables). Everything resolves
 * to an empty, harmless result so demo pages never hit the real backend. */
export function getFunctions() { return { __fns: true }; }
export function httpsCallable(_fns, name) {
  return async () => {
    console.info(`[demo] callable "${name}" stubbed`);
    return { data: { devices: [], ok: true, medications: [], edits: [] } };
  };
}
export function connectFunctionsEmulator() {}
