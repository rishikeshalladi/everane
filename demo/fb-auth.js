/* Stand-in for firebase-auth.js. Presents a permanently signed-in, verified
 * demo user so auth-guard.js lets the page render without a real account.
 */
const user = {
  uid: 'demo-user',
  email: 'margaret.demo@everane.live',
  displayName: 'Margaret Chen',
  emailVerified: true,
  getIdToken: async () => 'demo-token',
  getIdTokenResult: async () => ({ token: 'demo-token', claims: {} }),
  reload: async () => {},
  toJSON: () => ({ uid: 'demo-user' }),
};

const auth = {
  currentUser: user,
  onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; },
  signOut: async () => { window.location.href = '../index.html'; },
};

export function getAuth() { return auth; }
export function onAuthStateChanged(_a, cb) { setTimeout(() => cb(user), 0); return () => {}; }
export function onIdTokenChanged(_a, cb) { setTimeout(() => cb(user), 0); return () => {}; }
export async function reload() {}
export async function signOut() { window.location.href = '../index.html'; }
export async function signInWithEmailAndPassword() { return { user }; }
export async function createUserWithEmailAndPassword() { return { user }; }
export async function sendEmailVerification() {}
export async function sendPasswordResetEmail() {}
export async function updatePassword() {}
export async function updateProfile() {}
export async function deleteUser() {}
export function setPersistence() { return Promise.resolve(); }
export const browserLocalPersistence = 'local';
export class RecaptchaVerifier { constructor() {} render() { return Promise.resolve(1); } clear() {} }
export async function signInWithPhoneNumber() { return { confirm: async () => ({ user }) }; }
export class EmailAuthProvider { static credential() { return {}; } }
export async function reauthenticateWithCredential() { return { user }; }
