/* নখাপাড়া সপ্রাবি - নিরাপদ হাজিরা
 * স্তর ১: প্রত্যেক শিক্ষক নিজের লগইনে ঢুকে শুধু নিজের নামে হাজিরা দিতে পারবেন (নিয়মটি Firestore Rules-এও প্রয়োগ হয়)।
 * স্তর ২: হাজিরার আগে ফোন নিজে আঙুলের ছাপ / ফেস আনলক / স্ক্রিন লক চাইবে (WebAuthn)।
 * আঙুলের ছাপের তথ্য কখনো ফোনের বাইরে যায় না; অ্যাপ শুধু "যাচাই সফল" ফলাফল পায়।
 *
 * ব্যবহার: index.html-এ মূল স্ক্রিপ্টের পরে, firebase-sync.js লাইনের আগে এই লাইনটি দিন:
 *   <script src="secure-attendance.js"></script>
 */
(function () {
    'use strict';

    // ★★★ এখানে প্রত্যেক শিক্ষকের লগইন ইমেইল (ছোট হাতের অক্ষরে) ও নাম বসান।
    //     firestore.rules-এর teachers() তালিকার সঙ্গে ইমেইল ও নাম হুবহু মিলতে হবে।
    //     নাম অবশ্যই "শিক্ষক প্রোফাইল" ট্যাবের নামের (জনাব ছাড়া) মতো হতে হবে।
    const TEACHER_ACCOUNTS = {
        'ngps.bir127@gmail.com': 'চিত্তরঞ্জন রায়',
        'tt.physics99@gmail.com': 'তোফায়েল তোরাব'
            };
    const HEAD_EMAIL = 'ngps.bir127@gmail.com';   // শুধু ইনি বিদ্যালয়ের অবস্থান/সীমা বদলাতে ও অন্যের ভুল হাজিরা মুছতে পারবেন
    const REQUIRE_BIOMETRIC = true;                 // false করলে আঙুলের ছাপ চাওয়া বন্ধ (স্তর ২ বাদ)

    const KEY_ATT = 'nakhapara_attendance';
    const credKey = uid => 'nk_passkey_' + uid;

    // ---------- সাহায্যকারী ----------
    function me() {
        const u = window.fbCurrentUser;
        if (!u || !u.email) return null;
        const email = String(u.email).toLowerCase();
        return { email: email, uid: u.uid, name: TEACHER_ACCOUNTS[email] || null, isHead: email === HEAD_EMAIL.toLowerCase() };
    }
    function note(text, type) {
        if (typeof window.setMsg === 'function') window.setMsg('attMsg', text, type || 'info'); else alert(text);
    }
    function noteSchool(text, type) {
        if (typeof window.setMsg === 'function') window.setMsg('gpsSchoolMsg', text, type || 'error'); else alert(text);
    }
    function b64u(buf) {
        const bytes = new Uint8Array(buf); let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function fromB64u(s) {
        s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
        const bin = atob(s), out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    const enc = s => new TextEncoder().encode(s);
    const randomBytes = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
    function todayStr() {
        if (typeof window.isoToday === 'function') return window.isoToday();
        const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function readAtt() { try { const a = JSON.parse(localStorage.getItem(KEY_ATT) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

    // ---------- আঙুলের ছাপ (WebAuthn) ----------
    async function bioSupported() {
        try {
            return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials &&
                PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
                await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
        } catch (e) { return false; }
    }
    async function registerPasskey(m) {
        const cred = await navigator.credentials.create({ publicKey: {
            challenge: randomBytes(32),
            rp: { name: 'নখাপাড়া সপ্রাবি', id: location.hostname },
            user: { id: enc(m.uid), name: m.email, displayName: m.name },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
            timeout: 60000, attestation: 'none'
        } });
        if (!cred || !cred.rawId) throw new Error('নিবন্ধন সম্পূর্ণ হয়নি।');
        localStorage.setItem(credKey(m.uid), b64u(cred.rawId));
    }
    async function verifyPasskey(m) {
        const id = localStorage.getItem(credKey(m.uid));
        const challenge = randomBytes(32);
        const a = await navigator.credentials.get({ publicKey: {
            challenge: challenge, rpId: location.hostname,
            allowCredentials: [{ type: 'public-key', id: fromB64u(id) }],
            userVerification: 'required', timeout: 60000
        } });
        if (!a || !a.response) throw new Error('যাচাই সম্পূর্ণ হয়নি।');
        const flags = new Uint8Array(a.response.authenticatorData)[32];
        if (!(flags & 0x04)) throw new Error('আঙুলের ছাপ/স্ক্রিন লক যাচাই হয়নি।');
        const cd = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
        if (cd.type !== 'webauthn.get' || cd.challenge !== b64u(challenge)) throw new Error('যাচাই মেলেনি, আবার চেষ্টা করুন।');
    }
    function bioErr(e) {
        const n = e && e.name;
        if (n === 'NotAllowedError') return 'আঙুলের ছাপ নেওয়া বাতিল হয়েছে বা সময় শেষ হয়েছে। আবার চেষ্টা করুন। (আগে নিবন্ধন করা ছাপ মুছে গেলে নিচের "আঙুলের ছাপ নতুন করে নিবন্ধন" বাটন চাপুন।)';
        if (n === 'InvalidStateError') return 'এই ফোনে আগেই নিবন্ধন আছে। "আঙুলের ছাপ নতুন করে নিবন্ধন" চেপে আবার চেষ্টা করুন।';
        if (n === 'SecurityError') return 'নিরাপত্তার কারণে এই ঠিকানা থেকে আঙুলের ছাপ চালু করা যায়নি। সাইটটি https ঠিকানায় খুলুন।';
        if (n === 'NotSupportedError') return 'এই ফোন বা ব্রাউজারে আঙুলের ছাপ সুবিধা নেই।';
        return (e && e.message) || 'আঙুলের ছাপ যাচাই করা যায়নি।';
    }
    // true = এগোনো যাবে
    async function ensureBiometric(m) {
        if (!REQUIRE_BIOMETRIC) return true;
        if (!(await bioSupported())) {
            note('এই ফোনে আঙুলের ছাপ / ফেস আনলক / স্ক্রিন লক পাওয়া যায়নি। ফোনের সেটিংসে স্ক্রিন লক চালু করুন, আর Chrome ব্রাউজারে সাইটটি খুলুন।', 'error');
            return false;
        }
        if (!localStorage.getItem(credKey(m.uid))) {
            note('প্রথমবার: এই ফোনে আপনার আঙুলের ছাপ/স্ক্রিন লক নিবন্ধন করা হচ্ছে। ফোন যা চায় তা করুন।', 'info');
            await registerPasskey(m);      // নিবন্ধনের সময়েই ছাপ যাচাই হয়, তাই আবার চাওয়া হয় না
            updateStatus();
            return true;
        }
        note('আঙুলের ছাপ দিন...', 'info');
        await verifyPasskey(m);
        return true;
    }

    // ---------- হাজিরার ফাংশন মুড়ে নেওয়া ----------
    let busy = false;
    function wrap() {
        const origCheck = window.gpsCheck, origDel = window.delAtt, origRender = window.renderGps;
        const origHere = window.setSchoolHere, origManual = window.setSchoolManual, origRadius = window.saveRadius;

        if (typeof origCheck === 'function') window.gpsCheck = async function (kind) {
            if (busy) return;
            if (!window.fbEnabled) { note('নিরাপদ হাজিরার জন্য ক্লাউড লগইন চালু থাকতে হবে (firebase-config.js-এ কনফিগ বসান)।', 'error'); return; }
            const m = me();
            if (!m) { note('হাজিরার আগে লগইন করুন (নিচের কোণায় "লগইন")।', 'error'); return; }
            if (!m.name) { note(m.email + ' অ্যাকাউন্টটি শিক্ষকের তালিকায় নেই। প্রধান শিক্ষকের সঙ্গে যোগাযোগ করুন।', 'error'); return; }
            applyIdentity();
            busy = true;
            try {
                try { if (!(await ensureBiometric(m))) return; }
                catch (e) { note(bioErr(e), 'error'); return; }
                await origCheck(kind);       // জিপিএস যাচাই ও রেকর্ড (আপনার আগের কোড)
                stampBy(m);                  // রেকর্ডে লগইনের ইমেইল বসানো (Rules এটি মিলিয়ে দেখে)
            } finally { busy = false; }
        };

        if (typeof origDel === 'function') window.delAtt = function (id) {
            const m = me(), r = readAtt().find(x => x && String(x.id) === String(id));
            if (r && !(m && (m.isHead || (m.name && r.name === m.name)))) {
                alert('শুধু প্রধান শিক্ষক বা সংশ্লিষ্ট শিক্ষক নিজে হাজিরার নথি মুছতে পারবেন।'); return;
            }
            return origDel(id);
        };

        const headOnly = fn => function () {
            const m = me();
            if (!m || !m.isHead) { noteSchool('শুধু প্রধান শিক্ষক বিদ্যালয়ের অবস্থান ও হাজিরার সীমা বদলাতে পারবেন।', 'error'); return; }
            return fn.apply(this, arguments);
        };
        if (typeof origHere === 'function') window.setSchoolHere = headOnly(origHere);
        if (typeof origManual === 'function') window.setSchoolManual = headOnly(origManual);
        if (typeof origRadius === 'function') window.saveRadius = headOnly(origRadius);

        if (typeof origRender === 'function') window.renderGps = function () { const r = origRender.apply(this, arguments); applyIdentity(); return r; };
    }
    function stampBy(m) {
        const recs = readAtt(), today = todayStr(); let ch = false;
        recs.forEach(r => { if (r && !r.del && r.name === m.name && r.date === today && r.by !== m.email) { r.by = m.email; ch = true; } });
        if (ch) localStorage.setItem(KEY_ATT, JSON.stringify(recs));
    }

    // ---------- পর্দায় নাম বসানো ও অবস্থা দেখানো ----------
    function ensureUi() {
        try {
            if (document.getElementById('secBox')) return;
            const inp = document.getElementById('attName'); if (!inp || !inp.parentElement) return;
            const box = document.createElement('div');
            box.id = 'secBox'; box.className = 'mt-2 text-xs text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1';
            box.innerHTML = '<span id="secStatus"></span><button type="button" id="secRegBtn" class="px-2.5 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 font-semibold"><i class="fas fa-fingerprint"></i> আঙুলের ছাপ নতুন করে নিবন্ধন</button>';
            inp.parentElement.appendChild(box);
            document.getElementById('secRegBtn').addEventListener('click', reRegister);
        } catch (e) {}
    }
    async function reRegister() {
        const m = me();
        if (!m || !m.name) { note('আগে লগইন করুন।', 'error'); return; }
        if (!(await bioSupported())) { note('এই ফোনে আঙুলের ছাপ/স্ক্রিন লক পাওয়া যায়নি।', 'error'); return; }
        if (!confirm('এই ফোনে আপনার আঙুলের ছাপ/স্ক্রিন লক নতুন করে নিবন্ধন করবেন?')) return;
        try { note('ফোন যা চায় তা করুন...', 'info'); await registerPasskey(m); updateStatus(); note('নিবন্ধন সফল হয়েছে।', 'ok'); }
        catch (e) { note(bioErr(e), 'error'); }
    }
    function updateStatus() {
        try {
            const el = document.getElementById('secStatus'); if (!el) return;
            const m = me();
            if (!window.fbEnabled) { el.textContent = 'নিরাপদ হাজিরা বন্ধ: ক্লাউড লগইন চালু নেই।'; return; }
            if (!m) { el.textContent = 'হাজিরা দিতে আগে লগইন করুন।'; return; }
            if (!m.name) { el.textContent = m.email + ' শিক্ষকের তালিকায় নেই।'; return; }
            const reg = !!localStorage.getItem(credKey(m.uid));
            el.textContent = 'লগইন: ' + m.name + ' | আঙুলের ছাপ: ' + (reg ? 'এই ফোনে নিবন্ধিত' : 'এখনো নিবন্ধিত নয় (প্রথম হাজিরার সময় নিবন্ধন হবে)');
        } catch (e) {}
    }
    function applyIdentity() {
        try {
            ensureUi();
            const inp = document.getElementById('attName'); if (!inp) return;
            const m = me();
            inp.readOnly = true;
            if (inp.classList) inp.classList.add('bg-slate-100');
            if (m && m.name) inp.value = m.name;
            updateStatus();
        } catch (e) {}
    }

    wrap();
    applyIdentity();
    window.addEventListener('fbauth', applyIdentity);
})();
