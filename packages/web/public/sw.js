// srvMC as an installed web app. The panel shows live data from the computer, so nothing is
// cached: every request goes to the network. The worker exists so the browser offers to install.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
