// Registers the service worker that lets the app shell load with no network.
import { t } from '../i18n.js';
import { toast } from '../ui.js';

/** Safe to call anywhere: browsers without service workers, or insecure origins, simply skip it. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  // A controller change after the first install means a newer build took over; never reload a till mid-sale on our own.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast(t('offline.updateReady'), 'info');
  });
  const register = () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); };
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}
