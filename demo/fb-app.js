/* Stand-in for firebase-app.js. */
const app = { name: '[DEFAULT]', options: { projectId: 'everane-demo' } };
export function initializeApp() { return app; }
export function getApps() { return [app]; }
export function getApp() { return app; }
export function deleteApp() { return Promise.resolve(); }
