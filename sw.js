/* নখাপাড়া সপ্রাবি: অফলাইন সাপোর্টের জন্য Service Worker
 * সাইটে বড় কোনো পরিবর্তন করলে নিচের VERSION সংখ্যা বাড়িয়ে দিন (যেমন v2),
 * তাহলে সবার ফোনে নতুন সংস্করণ চালু হবে। */
const VERSION = 'nakhapara-v2';

// সাইটের মূল ফাইল
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// বাইরের লাইব্রেরি (ইন্টারনেট থেকে আসে), আগেভাগে জমিয়ে রাখা হয়
const EXTERNAL = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(APP_SHELL);
    // বাইরের ফাইল আনা না গেলেও ইনস্টল যেন আটকে না যায়
    await Promise.all(EXTERNAL.map(async url => {
      try {
        const res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch (e) { /* ইন্টারনেট না থাকলে বাদ */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // পাতা খোলা: আগে ইন্টারনেট থেকে নতুনটা, না পেলে জমানো কপি
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match('./index.html');
        return cached || new Response('অফলাইন: পাতাটি পাওয়া যায়নি।', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // বাকি সব (স্ক্রিপ্ট, ফন্ট, আইকন, ছবি): জমানোটা সঙ্গে সঙ্গে দেখায়, পেছনে নতুন করে আনে
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});
