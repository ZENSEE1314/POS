// Wires the offline layer into the app: API hooks, service worker, connectivity monitor.
import { setOfflineHooks } from '../session.js';
import './strings.js';
import { emulate, isEmulated, afterNetwork, ownsRequest } from './emulator.js';
import { getState, markOffline, markOnline, startSync, onSignedIn } from './sync.js';
import { registerServiceWorker } from './register.js';

export { syncPillHtml, mountSyncPill, openSyncPanel } from './panel.js';
export { getState as syncState, syncNow, forgetEverything, SYNCED_EVENT, realBillId } from './sync.js';

export function initOffline() {
  setOfflineHooks({
    isOffline: () => !getState().online,
    emulated: isEmulated,
    owns: ownsRequest,
    emulate,
    after: afterNetwork,
    networkDown: markOffline,
    networkUp: markOnline,
  });
  startSync();
  registerServiceWorker();
}

export const offlineSignedIn = onSignedIn;
