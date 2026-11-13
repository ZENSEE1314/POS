// NightPOS service worker: precaches the app shell so the till loads with no network. It never touches the API.
//
// The server replaces the BUILD placeholder below with { version, files }: every file under public/ and a hash of all of
// their contents. A changed file therefore changes this script, which is what makes the browser install the update.
// The cache is named after that version and filled completely or not at all, so a page can never mix files from two builds
// (which is why precached files are not revalidated one by one: freshness comes from the version, not from per-file checks).
const BUILD = /*BUILD*/ null;
const PREFIX = 'nightpos-shell-';
const CACHE = `${PREFIX}${BUILD ? BUILD.version : 'unversioned'}`;
const SHELL_URL = '/';
// Anything dynamic must always reach the server (and /healthz is the connectivity probe).
const NEVER_CACHE = /^\/(api|platform|webhooks|dev|healthz)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (BUILD) {
      const cache = await caches.open(CACHE);
      const urls = [SHELL_URL, ...BUILD.files.map((f) => `/${f}`)];
      await Promise.all(urls.map(async (url) => {
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) throw new Error(`precache failed for ${url}: ${res.status}`);
        await cache.put(url, res);
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function respond(request, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.mode === 'navigate' ? SHELL_URL : url.pathname);
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (e) {
    const shell = request.mode === 'navigate' ? await cache.match(SHELL_URL) : undefined;
    if (shell) return shell;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;
  event.respondWith(respond(request, url));
});
