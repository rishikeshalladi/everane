
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

const depth = window.location.pathname.split('/').filter(Boolean).length;
const inSubfolder = window.location.pathname.includes('/caregiver/');
const loginPath = inSubfolder ? '../login.html' : 'login.html';
const medicomPath = inSubfolder ? '../medicom.html' : 'medicom.html';
const profilePath = inSubfolder ? '../profile.html' : 'profile.html';

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

  try { await reload(user); } catch (_) {}

  if (!user.emailVerified) {
    try { await signOut(auth); } catch (_) {}
    window.location.href = loginPath;
    return;
  }

  try {
    const cached = localStorage.getItem('hasDoctorAccount_' + user.uid);

    if (cached === 'true') {
      const s = document.getElementById('hide-medicom-style');
      if (s) s.remove();
    } else {
      const db = getFirestore(app);
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists() && snap.data().doctorPassword) {
        localStorage.setItem('hasDoctorAccount_' + user.uid, 'true');
        const s = document.getElementById('hide-medicom-style');
        if (s) s.remove();
      } else {
        localStorage.removeItem('hasDoctorAccount_' + user.uid);

        const currentPage = window.location.pathname.split('/').pop();
        if (currentPage === 'medicom.html' || currentPage === 'patientrequest.html') {
          window.location.href = profilePath;
        }
      }
    }
  } catch (e) {
    console.warn('[auth-guard] Could not check doctor account status:', e);
    const s = document.getElementById('hide-medicom-style');
    if (s) s.remove();
  }
});
