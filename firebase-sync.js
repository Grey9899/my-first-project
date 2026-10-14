// নখাপাড়া সপ্রাবি - Firebase লগইন ও ক্লাউড সিঙ্ক (Spark প্ল্যান, কার্ড ছাড়া)
// কাজের ধরন: অ্যাপ আগের মতোই localStorage-এ লেখে; এই ফাইল সেই লেখা ধরে Firestore-এ পাঠায়
// এবং অন্য ডিভাইসের বদল নামিয়ে localStorage-এ বসিয়ে পর্দা নতুন করে আঁকতে বলে (window.onRemoteData)।
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail }
    from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, getDocs,
         setDoc, writeBatch, onSnapshot, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// কনফিগ বসানো না হলে কিছুই করে না (অ্যাপ ডিভাইসে একাই চলে)
if (!firebaseConfig || !firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith('PASTE')) {
    console.info('Firebase কনফিগ বসানো হয়নি, সিঙ্ক বন্ধ।');
} else {
    try { boot(); }
    catch (e) {
        // সিঙ্কে যেকোনো ত্রুটি হলেও অ্যাপ যেন কখনো আটকে না যায়
        console.error('ক্লাউড সিঙ্ক চালু করা যায়নি:', e);
        const ov = document.getElementById('fbLogin'); if (ov) ov.remove();
    }
}

// <helpers>
const str = v => (v == null ? '' : String(v));
const cleanStr = (r, fields) => { const o = { id: Number(r.id) }; fields.forEach(f => { o[f] = str(r[f]); }); return o; };
const cleanGeo = g => {
    if (!g || typeof g !== 'object') return null;
    const lat = Number(g.lat), lng = Number(g.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng, acc: Number(g.acc) || 0, dist: Number(g.dist) || 0 };
};
// শিক্ষকের হাজিরা: আইডি লেখা, সময় সংখ্যা, অবস্থান (lat/lng) আলাদা অবজেক্ট; মুছে ফেলা হলে del-এ সময় থাকে
const cleanAtt = r => {
    const o = { id: str(r.id), name: str(r.name), date: str(r.date) };
    ['inAt', 'outAt', 'del'].forEach(f => { const n = Number(r[f]); if (r[f] != null && r[f] !== '' && isFinite(n) && n) o[f] = n; });
    ['inGeo', 'outGeo'].forEach(f => { const g = cleanGeo(r[f]); if (g) o[f] = g; });
    if (r.by) o.by = str(r.by);   // কোন লগইন (ইমেইল) থেকে হাজিরা দেওয়া হয়েছে
    return o;
};
const docIdOf = id => str(id).replace(/[\/\s]/g, '_');
// </helpers>

function boot() {
    // ---------- কোন তথ্য সিঙ্ক হবে ----------
    // তালিকা-ধরনের তথ্য: প্রতিটি রেকর্ড আলাদা ডকুমেন্ট (দুজনের লেখা কম সংঘর্ষ করে)
    // কী = localStorage-এর নাম, coll = Firestore কালেকশনের নাম
    const REC = {
        lessonPlans: { coll: 'lessonPlans', numId: true, clean: r => cleanStr(r, ['date', 'className', 'subject', 'title', 'details', 'teacher']) },
        students: { coll: 'students', numId: true, clean: r => cleanStr(r, ['name', 'className', 'roll', 'phone']) },
        nakhapara_attendance: { coll: 'attendance', numId: false, clean: cleanAtt }
    };
    // বাকি তথ্য: প্রতিটি কী একটি ডকুমেন্ট (kv/{কী})
    const KV = [
        'nakhapara_glance_data', 'nakhapara_senior_officers',
        'nakhapara_last_visit_date', 'nakhapara_last_visit_officer', 'nakhapara_last_visit_desig',
        'nakhapara_visit_desig_options', 'nakhapara_evaluation', 'nakhapara_stu_attendance',
        'nakhapara_school_geo', 'nakhapara_school_radius', 'nakhapara_last_visit_geo', 'nakhapara_social_links'
    ];
    const RKEYS = Object.keys(REC);
    const ALL_KEYS = RKEYS.concat(KV);

    // অন্য স্ক্রিপ্ট (secure-attendance.js) জানতে পারবে ক্লাউড চালু আছে কি না
    window.fbEnabled = true;
    // ---------- অবস্থা ----------
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    let user = null, unsubs = [], pending = 0, lastError = '', applying = false, authResolved = false;
    const lastRec = {}; RKEYS.forEach(k => { lastRec[k] = new Map(); });
    const lastKv = {};
    const pushTimers = {};
    const origSet = Storage.prototype.setItem;
    const origRemove = Storage.prototype.removeItem;
    const origGet = Storage.prototype.getItem;
    const ls = { get: k => origGet.call(localStorage, k), set: (k, v) => origSet.call(localStorage, k, v), del: k => origRemove.call(localStorage, k) };
    const $ = id => document.getElementById(id);

    // নিজের অ্যাপের লেখা ধরার জন্য setItem মুড়ে দেওয়া (ফিরতি লেখার সময় applying=true থাকে, তাই ঘুরে আসে না)
    Storage.prototype.setItem = function (k, v) {
        origSet.call(this, k, v);
        if (this === localStorage && !applying && user && ALL_KEYS.includes(k)) schedulePush(k);
    };
    function lsWrite(k, v) { applying = true; try { ls.set(k, v); } finally { applying = false; } }

    // ---------- সাহায্যকারী ----------
    function readArr(k) { try { const a = JSON.parse(ls.get(k) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    function idOk(k, r) { return !!r && (REC[k].numId ? isFinite(Number(r.id)) && r.id !== '' && r.id != null : r.id != null && str(r.id).trim() !== ''); }
    function errMsg(e) {
        const c = (e && e.code) || '';
        if (c.includes('permission-denied')) return 'অনুমতি নেই। আপনার ইমেইল Security Rules-এর অনুমোদিত তালিকায় আছে কি না দেখুন।';
        return (e && (e.message || e.code)) || String(e);
    }
    function authMsg(e) {
        const c = (e && e.code) || '';
        if (/invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/.test(c)) return 'ইমেইল বা পাসওয়ার্ড ভুল।';
        if (c.includes('too-many-requests')) return 'অনেকবার ভুল চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
        if (c.includes('network')) return 'ইন্টারনেট সংযোগ নেই।';
        if (c.includes('user-disabled')) return 'এই অ্যাকাউন্ট বন্ধ করা আছে।';
        if (c.includes('unauthorized-domain')) return 'এই সাইটের ঠিকানা Firebase-এ অনুমোদিত নয়। Authentication → Settings → Authorized domains-এ ঠিকানাটি যোগ করুন।';
        return 'লগইন করা যায়নি (' + (c || 'অজানা ত্রুটি') + ')।';
    }

    // ---------- নিচের কোণার অবস্থা-চিহ্ন ----------
    const chip = document.createElement('div');
    chip.id = 'fbChip';
    chip.className = 'no-print hidden fixed bottom-3 left-3 z-[55] items-center gap-2 px-3 py-2 rounded-full bg-white border border-slate-200 shadow-lg text-xs text-slate-700 max-w-[92vw]';
    chip.innerHTML = '<span id="fbChipText"></span><button type="button" id="fbChipBtn" class="font-semibold"></button>';
    document.body.appendChild(chip);
    $('fbChipBtn').onclick = () => { if (user) logout(); else showLogin(); };

    function setStatus() {
        const btn = $('fbChipBtn');
        chip.classList.remove('hidden'); chip.classList.add('flex');
        if (!user) {
            // লগইন হয়নি (যেমন ইন্টারনেট ছিল না): অ্যাপ চালু থাকে, কিন্তু সিঙ্ক হয় না
            $('fbChipText').innerHTML = '<i class="fas fa-cloud-bolt text-amber-500"></i> ক্লাউড সিঙ্ক বন্ধ';
            btn.textContent = 'লগইন'; btn.className = 'font-semibold text-brand-700 hover:underline';
            return;
        }
        btn.textContent = 'লগআউট'; btn.className = 'font-semibold text-slate-400 hover:text-red-600';
        let t;
        if (!navigator.onLine) t = '<i class="fas fa-cloud text-amber-500"></i> অফলাইন, নেট এলে সিঙ্ক হবে';
        else if (lastError) t = '<i class="fas fa-exclamation-triangle text-red-500"></i> সিঙ্ক ত্রুটি';
        else if (pending > 0) t = '<i class="fas fa-sync fa-spin text-blue-500"></i> সিঙ্ক হচ্ছে...';
        else t = '<i class="fas fa-cloud text-emerald-500"></i> সিঙ্ক হয়েছে';
        $('fbChipText').innerHTML = t;
        chip.title = (user.email || '') + (lastError ? '\n' + lastError : '');
    }
    window.addEventListener('online', setStatus);
    window.addEventListener('offline', setStatus);

    // ---------- লগইন পর্দা ----------
    const overlay = document.createElement('div');
    overlay.id = 'fbLogin';
    overlay.className = 'no-print fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/90 backdrop-blur-sm p-4';
    overlay.innerHTML =
        '<div class="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4">' +
          '<div class="text-center"><div class="w-14 h-14 mx-auto rounded-2xl bg-brand-900 text-amber-300 flex items-center justify-center text-2xl mb-3"><i class="fas fa-school"></i></div>' +
          '<h2 class="text-lg font-bold text-slate-800">নখাপাড়া সরকারি প্রাথমিক বিদ্যালয়</h2>' +
          '<p class="text-xs text-slate-500">শিক্ষকদের লগইন</p></div>' +
          '<div id="fbLoading" class="text-center text-sm text-slate-500 py-4"><i class="fas fa-spinner fa-spin"></i> লোড হচ্ছে...</div>' +
          '<form id="fbForm" class="hidden space-y-3">' +
            '<input id="fbEmail" type="email" autocomplete="username" required placeholder="ইমেইল" class="w-full px-3 py-2.5 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-brand-500">' +
            '<input id="fbPass" type="password" autocomplete="current-password" required placeholder="পাসওয়ার্ড" class="w-full px-3 py-2.5 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-brand-500">' +
            '<p id="fbMsg" class="text-xs min-h-[1rem]"></p>' +
            '<button id="fbBtn" type="submit" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-sm">লগইন করুন</button>' +
            '<button id="fbReset" type="button" class="w-full text-xs text-slate-500 hover:text-brand-700">পাসওয়ার্ড ভুলে গেছেন?</button>' +
          '</form>' +
        '</div>';
    document.body.appendChild(overlay);
    function loginMsg(text, ok) { const m = $('fbMsg'); m.textContent = text; m.className = 'text-xs min-h-[1rem] ' + (ok ? 'text-emerald-700' : 'text-red-600'); }
    $('fbForm').onsubmit = async e => {
        e.preventDefault();
        const btn = $('fbBtn'); btn.disabled = true; loginMsg('', true);
        try { await signInWithEmailAndPassword(auth, $('fbEmail').value.trim(), $('fbPass').value); }
        catch (err) { loginMsg(authMsg(err), false); }
        finally { btn.disabled = false; }
    };
    $('fbReset').onclick = async () => {
        const em = $('fbEmail').value.trim();
        if (!em) { loginMsg('আগে ইমেইল ঘরে ইমেইল লিখুন।', false); return; }
        try { await sendPasswordResetEmail(auth, em); loginMsg('পাসওয়ার্ড বদলের লিংক ইমেইলে পাঠানো হয়েছে।', true); }
        catch (err) { loginMsg(authMsg(err), false); }
    };
    function showLogin() { overlay.classList.remove('hidden'); $('fbLoading').classList.add('hidden'); $('fbForm').classList.remove('hidden'); }
    function hideLogin() { overlay.classList.add('hidden'); $('fbPass').value = ''; }

    // সুরক্ষা: ১০ সেকেন্ডেও ক্লাউড থেকে সাড়া না এলে লগইন পর্দা সরিয়ে অ্যাপ চালু করে দেওয়া হয় (যাতে কখনো আটকে না যায়)
    setTimeout(() => {
        if (authResolved) return;
        console.warn('Firebase সাড়া দেয়নি, অ্যাপ সিঙ্ক ছাড়া চালু করা হলো।');
        hideLogin(); setStatus();
    }, 10000);

    // ---------- Firestore-এ পাঠানো ----------
    function track(p) {
        pending++; setStatus();
        p.then(() => { lastError = ''; })
         .catch(e => { lastError = errMsg(e); console.error('সিঙ্ক ত্রুটি:', e); })
         .finally(() => { pending--; setStatus(); });
    }
    function schedulePush(k) {
        clearTimeout(pushTimers[k]);
        pushTimers[k] = setTimeout(() => { delete pushTimers[k]; pushKey(k); }, 400);
    }
    function pushKey(k) { if (!user) return; if (REC[k]) pushRecords(k); else pushKv(k); }

    function pushKv(k) {
        const v = ls.get(k);
        lastKv[k] = v;
        if (v == null) return;
        track(setDoc(doc(db, 'kv', k), { value: v, updatedAt: serverTimestamp(), by: user.email || '' }));
    }
    function pushRecords(k) {
        const cfg = REC[k], last = lastRec[k], cur = new Map(), ops = [];
        readArr(k).forEach(r => { if (idOk(k, r)) { const c = cfg.clean(r); cur.set(docIdOf(c.id), c); } });
        cur.forEach((data, id) => { const s = JSON.stringify(data); if (last.get(id) !== s) ops.push({ t: 's', id, data, s }); });
        last.forEach((s, id) => { if (!cur.has(id)) ops.push({ t: 'd', id }); });
        for (let i = 0; i < ops.length; i += 400) {
            const batch = writeBatch(db);
            ops.slice(i, i + 400).forEach(o => {
                if (o.t === 's') { batch.set(doc(db, cfg.coll, o.id), o.data); last.set(o.id, o.s); }
                else { batch.delete(doc(db, cfg.coll, o.id)); last.delete(o.id); }
            });
            track(batch.commit());
        }
    }

    // ---------- Firestore থেকে নামানো ----------
    let notifyTimer = null; const changedKeys = new Set();
    function notify(k) {
        changedKeys.add(k);
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => {
            const keys = new Set(changedKeys); changedKeys.clear();
            try { if (typeof window.onRemoteData === 'function') window.onRemoteData(keys); } catch (e) { console.error(e); }
        }, 150);
    }
    function listenRecords(k) {
        const cfg = REC[k];
        return onSnapshot(collection(db, cfg.coll), snap => {
            const last = lastRec[k]; let changed = false;
            snap.docChanges().forEach(ch => {
                const id = ch.doc.id;
                if (ch.type === 'removed') { if (last.delete(id)) changed = true; return; }
                const d = ch.doc.data();
                if (!idOk(k, d)) return;
                const s = JSON.stringify(cfg.clean(d));
                if (last.get(id) !== s) { last.set(id, s); changed = true; }
            });
            if (!changed) return;
            const arr = Array.from(last.values()).map(s => JSON.parse(s));
            arr.sort((a, b) => {
                if (cfg.numId) return k === 'lessonPlans' ? b.id - a.id : a.id - b.id;
                return str(a.id) < str(b.id) ? -1 : 1;
            });
            lsWrite(k, JSON.stringify(arr));
            notify(k);
        }, e => { lastError = errMsg(e); setStatus(); console.error(e); });
    }
    function listenKv() {
        return onSnapshot(collection(db, 'kv'), snap => {
            snap.docChanges().forEach(ch => {
                const k = ch.doc.id;
                if (!KV.includes(k) || ch.type === 'removed') return;
                if (pushTimers[k]) return;                 // এই ডিভাইসের অসংরক্ষিত লেখা আছে, সেটিই জিতবে
                const v = ch.doc.data().value;
                if (typeof v !== 'string' || v === lastKv[k] || v === ls.get(k)) { if (typeof v === 'string') lastKv[k] = v; return; }
                lastKv[k] = v;
                lsWrite(k, v);
                notify(k);
            });
        }, e => { lastError = errMsg(e); setStatus(); console.error(e); });
    }

    // ---------- প্রথমবার: এই ডিভাইসের তথ্য ক্লাউডে তোলা ----------
    function hasLocalData() { return RKEYS.some(k => readArr(k).length) || KV.some(k => ls.get(k) != null); }
    async function uploadMissing() {
        const cloud = {};
        for (const k of RKEYS) cloud[k] = new Set((await getDocs(collection(db, REC[k].coll))).docs.map(d => d.id));
        const cloudKv = new Set((await getDocs(collection(db, 'kv'))).docs.map(d => d.id));
        let batch = writeBatch(db), n = 0; const jobs = [];
        const flush = () => { if (n) { jobs.push(batch.commit()); batch = writeBatch(db); n = 0; } };
        RKEYS.forEach(k => readArr(k).forEach(r => {
            if (!idOk(k, r)) return;
            const c = REC[k].clean(r), id = docIdOf(c.id);
            if (cloud[k].has(id)) return;
            batch.set(doc(db, REC[k].coll, id), c); if (++n >= 400) flush();
        }));
        KV.forEach(k => {
            const v = ls.get(k);
            if (v == null || cloudKv.has(k)) return;
            batch.set(doc(db, 'kv', k), { value: v, updatedAt: serverTimestamp(), by: user.email || '' }); if (++n >= 400) flush();
        });
        flush();
        await Promise.all(jobs);
    }
    async function initialSync() {
        const flag = 'fb_init_' + user.uid;
        if (ls.get(flag)) return;
        try {
            const metaRef = doc(db, 'kv', '_meta');
            const meta = await getDoc(metaRef);
            if (!meta.exists()) {
                await uploadMissing();
                await setDoc(metaRef, { createdAt: serverTimestamp(), by: user.email || '' });
            } else if (hasLocalData() &&
                confirm('ক্লাউডে আগে থেকেই বিদ্যালয়ের তথ্য আছে, আর এই ডিভাইসেও কিছু তথ্য আছে।\n\nOK চাপলে এই ডিভাইসের নতুন তথ্য ক্লাউডের সঙ্গে মিলিয়ে দেওয়া হবে।\nCancel চাপলে এই ডিভাইসের তথ্য বাদ দিয়ে ক্লাউডের তথ্য নেওয়া হবে।\n\n(ছবির গ্যালারি এতে প্রভাবিত হয় না।)')) {
                await uploadMissing();
            }
            ls.set(flag, '1');
        } catch (e) {
            lastError = errMsg(e); setStatus(); console.error('প্রথম সিঙ্ক ব্যর্থ:', e);
        }
    }

    async function start() {
        await initialSync();
        RKEYS.forEach(k => { unsubs.push(listenRecords(k)); });
        unsubs.push(listenKv());
    }
    function stop() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; RKEYS.forEach(k => lastRec[k].clear()); }

    async function logout() {
        if (pending > 0 && !confirm('কিছু তথ্য এখনও সিঙ্ক হয়নি। এখন লগআউট করলে তা হারাতে পারে। তবুও লগআউট করবেন?')) return;
        if (!confirm('লগআউট করলে এই ডিভাইস থেকে স্কুলের তথ্য (ছবি ছাড়া) মুছে যাবে। তথ্য ক্লাউডে নিরাপদ থাকবে এবং আবার লগইন করলে ফিরে আসবে। এগিয়ে যাবেন?')) return;
        stop();
        try { await signOut(auth); } catch (e) {}
        ALL_KEYS.forEach(k => ls.del(k));
        location.reload();
    }

    function announceUser() {
        window.fbCurrentUser = user ? { email: user.email || '', uid: user.uid } : null;
        try { window.dispatchEvent(new Event('fbauth')); } catch (e) {}
    }
    onAuthStateChanged(auth, async u => {
        authResolved = true;
        if (u) { user = u; announceUser(); hideLogin(); setStatus(); await start(); }
        else { stop(); user = null; announceUser(); setStatus(); showLogin(); }
    }, err => {
        authResolved = true; console.error('লগইন যাচাইয়ে ত্রুটি:', err);
        hideLogin(); setStatus();
    });
}
