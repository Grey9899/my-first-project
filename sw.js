// নখাপাড়া সপ্রাবি - Service Worker
// ফাইল বদলালে নিচের সংস্করণ নম্বর বাড়ান, তাহলে পুরনো ক্যাশ মুছে নতুন ক্যাশ হবে।
const VERSION = 'v5';
const SHELL = 'nakhapara-shell-' + VERSION;
const RUNTIME = 'nakhapara-runtime-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './firebase-config.js',
  './firebase-sync.js',
  './secure-attendance.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// প্রথমবার অনলাইনে খুললে এগুলো ক্যাশে চলে যাবে, পরে অফলাইনেও চলবে
const CDN_FILES = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    // একটি ফাইল না পেলেও ইনস্টল যেন আটকে না যায়
    await Promise.all(SHELL_FILES.map(u => shell.add(u).catch(() => {})));
    const rt = await caches.open(RUNTIME);
    await Promise.all(CDN_FILES.map(u =>
      fetch(u, { mode: 'no-cors' }).then(r => rt.put(u, r)).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;

  // Firebase এর লাইভ সংযোগ (ডেটাবেস, লগইন) কখনো ক্যাশ করা যাবে না, সরাসরি নেটওয়ার্কে যাবে
  const h = url.hostname;
  if ((h.endsWith('googleapis.com') && h !== 'fonts.googleapis.com') || h.endsWith('firebaseio.com') ||
      h.endsWith('firebaseinstallations.googleapis.com') || h.endsWith('cloudfunctions.net')) return;

  // পেজ খোলা: আগে নেটওয়ার্ক (নতুন সংস্করণ পেতে), না পেলে ক্যাশ
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) || (await caches.match('./')) ||
          new Response('অফলাইন: এখনও ক্যাশ হয়নি। একবার ইন্টারনেট দিয়ে খুলুন।', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // বাকি সব (CSS, ফন্ট, ছবি, স্ক্রিপ্ট): ক্যাশ থেকে দেখাও, পেছনে নতুন করে আনো
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const c = await caches.open(url.origin === location.origin ? SHELL : RUNTIME);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});
