import admin from 'firebase-admin';

let firebaseApp = null;

/**
 * Initialize Firebase Admin. Supports:
 * 1. GOOGLE_APPLICATION_CREDENTIALS env var (service account JSON path)
 * 2. FIREBASE_SERVICE_ACCOUNT env var (JSON string)
 * 3. FIREBASE_PROJECT_ID env var (for default credentials / GCE)
 */
export function initFirebaseAuth() {
  if (firebaseApp) return;

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      firebaseApp = admin.initializeApp();
    } else if (process.env.FIREBASE_PROJECT_ID) {
      firebaseApp = admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    } else {
      console.warn('[firebase-auth] No Firebase credentials configured — auth disabled');
      return;
    }
    console.log('[firebase-auth] Initialized');
  } catch (err) {
    // Already initialized (e.g., from another module)
    if (err.code === 'app/duplicate-app') {
      firebaseApp = admin.app();
    } else {
      console.error('[firebase-auth] Init failed:', err.message);
    }
  }
}

/**
 * Verify a Firebase ID token.
 * Returns decoded token { uid, email, name, ... } or null on failure.
 */
export async function verifyIdToken(token) {
  if (!firebaseApp) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || decoded.email?.split('@')[0] || null,
      picture: decoded.picture || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Check if Firebase Auth is available.
 */
export function isAuthEnabled() {
  return !!firebaseApp;
}
