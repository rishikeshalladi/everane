/**
 * auth-guard.js — Redirect unauthenticated users to login.html
 *
 * Include this script on any page that requires authentication.
 * It uses Firebase Auth onAuthStateChanged to detect when a user
 * is not signed in and immediately redirects to login.html.
 *
 * Also hides the Communication nav link until the user has created
 * a Doctor Access Account (patient ID + password).
 *
 * Usage (root pages):   <script src="auth-guard.js" type="module"></script>
 * Usage (caregiver/):   <script src="../auth-guard.js" type="module"></script>
 *
 * Must be placed BEFORE the page's own Firebase init script so the
 * redirect fires as early as possible.
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, reload }   from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc }     from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD6wbL8ubfOSlyodvwuh_1gTL-7FK065pk",
  authDomain: "medtracker-8c467.firebaseapp.com",
  projectId: "medtracker-8c467",
  storageBucket: "medtracker-8c467.firebasestorage.app",
  messagingSenderId: "847799899373",
  appId: "1:847799899373:web:170bf9c693a78ec42168e4"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

// Figure out the correct relative path to login.html
const depth = window.location.pathname.split('/').filter(Boolean).length;
const inSubfolder = window.location.pathname.includes('/caregiver/');
const loginPath = inSubfolder ? '../login.html' : 'login.html';
const medicomPath = inSubfolder ? '../medicom.html' : 'medicom.html';
const profilePath = inSubfolder ? '../profile.html' : 'profile.html';

// Immediately hide Communication link via CSS to prevent flash
(function hideMedicomLink() {
  const style = document.createElement('style');
  style.textContent = 'a[href="medicom.html"], a[href="../medicom.html"] { display: none !important; }';
  style.id = 'hide-medicom-style';
  document.head.appendChild(style);
})();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = loginPath;
    return;
  }

  // Refresh from the server so a user who just verified in another tab isn't
  // wrongly bounced on a stale cached token (and vice-versa).
  try { await reload(user); } catch (_) {}

  // Block unverified accounts from protected pages. Sign them out and send
  // them back to login, where they can resend the verification email.
  if (!user.emailVerified) {
    try { await signOut(auth); } catch (_) {}
    window.location.href = loginPath;
    return;
  }

  // Check if user has created a doctor access account
  try {
    const cached = localStorage.getItem('hasDoctorAccount_' + user.uid);

    if (cached === 'true') {
      // Fast path: show the link immediately from cache
      const s = document.getElementById('hide-medicom-style');
      if (s) s.remove();
    } else {
      // Check Firestore
      const db = getFirestore(app);
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists() && snap.data().doctorPassword) {
        localStorage.setItem('hasDoctorAccount_' + user.uid, 'true');
        const s = document.getElementById('hide-medicom-style');
        if (s) s.remove();
      } else {
        // No doctor account — keep link hidden
        localStorage.removeItem('hasDoctorAccount_' + user.uid);

        // If user is ON the medicom page, redirect them to profile
        const currentPage = window.location.pathname.split('/').pop();
        if (currentPage === 'medicom.html' || currentPage === 'patientrequest.html') {
          window.location.href = profilePath;
        }
      }
    }
  } catch (e) {
    console.warn('[auth-guard] Could not check doctor account status:', e);
    // On error, show the link anyway so it's not permanently hidden
    const s = document.getElementById('hide-medicom-style');
    if (s) s.remove();
  }
});
