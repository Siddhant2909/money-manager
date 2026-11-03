"use strict";
// App lock: asks for a PIN (or the phone's fingerprint / face unlock) when the app opens on this device,
// and again after it has been away (in the background, closed or reloading) for longer than the chosen time.
// It's a privacy screen for this device. The data itself stays protected by the Google sign-in and the
// server session; the PIN never leaves the device and is stored only as a salted PBKDF2 hash.
const MMLock = (() => {
  const { $ } = MM;
  const KEY = "mm_lock_v1";
  const SEEN = "mm_lock_seen";   // when the app was last used unlocked on this device
  const GRACE = 15;              // seconds: a reload never asks again, even with "Immediately"
  const ITER = 150000;
  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

  // ----- settings kept on this device -----
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } }
  function store(c) {
    try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else { localStorage.removeItem(KEY); localStorage.removeItem(SEEN); } return true; } catch { return false; }
  }
  const forUser = (email) => { const c = load(); return c && email && c.email === email ? c : null; };
  const supported = () => !!(window.crypto && crypto.subtle && window.localStorage);

  async function hashPin(pin, salt) {
    const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
    return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: ITER }, key, 256));
  }
  async function pinMatches(c, pin) {
    const h = await hashPin(pin, c.salt);
    let diff = h.length ^ c.hash.length;
    for (let i = 0; i < Math.min(h.length, c.hash.length); i++) diff |= h.charCodeAt(i) ^ c.hash.charCodeAt(i);
    return diff === 0;
  }

  // ----- fingerprint / face unlock (WebAuthn platform authenticator, checked on the device) -----
  async function bioAvailable() {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch { return false; }
  }
  async function createBio(email, name) {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Money Manager" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: email, displayName: name || email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000, attestation: "none",
    } });
    return b64(cred.rawId);
  }
  async function bioPasses(id) {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: unb64(id) }],
      userVerification: "required", timeout: 60000,
    } });
    // flags byte (offset 32) bit 2 = the user was verified by fingerprint / face / device PIN
    return !!(a && a.response && (new Uint8Array(a.response.authenticatorData)[32] & 0x04));
  }

  // ----- the lock screen -----
  let pending = null, entered = "", fails = 0, coolUntil = 0, cfg = null, coolTimer = null;
  function dots() {
    const n = cfg ? cfg.len : 4;
    $("lkDots").innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < entered.length ? "on" : ""}"></span>`).join("");
  }
  function message(t, bad) { $("lkMsg").textContent = t; $("lkMsg").classList.toggle("bad", !!bad); }
  function cooling() {
    const left = Math.ceil((coolUntil - Date.now()) / 1000);
    if (left > 0) {
      message(`Too many tries. Try again in ${left}s.`, true);
      $("lkPad").classList.add("off");
      clearTimeout(coolTimer); coolTimer = setTimeout(cooling, 1000);
      return true;
    }
    $("lkPad").classList.remove("off");
    if ($("lkMsg").classList.contains("bad")) message("");
    return false;
  }
  function done(ok) {
    const p = pending; pending = null; entered = "";
    if (ok) { unlocked = true; markSeen(); }
    clearTimeout(coolTimer);
    if ($("lockDlg").open) $("lockDlg").close();
    if (p) p(ok);
  }
  async function tryBio() {
    if (!cfg || !cfg.bio || cooling()) return;
    try { if (await bioPasses(cfg.bio)) { fails = 0; done(true); } }
    catch { /* cancelled or not allowed without a tap: the PIN pad is still there */ }
  }
  async function press(k) {
    if (!pending || cooling()) return;
    if (k === "del") { entered = entered.slice(0, -1); dots(); return; }
    if (k === "bio") { tryBio(); return; }
    if (entered.length >= cfg.len) return;
    entered += k; dots();
    if (entered.length < cfg.len) return;
    const pin = entered;
    if (await pinMatches(cfg, pin)) { fails = 0; done(true); return; }
    fails += 1; entered = "";
    $("lkDots").classList.remove("shake"); void $("lkDots").offsetWidth; $("lkDots").classList.add("shake");
    dots();
    if (fails >= 5) { coolUntil = Date.now() + 30000 * (fails - 4); cooling(); }
    else message(`Wrong PIN. ${5 - fails} tr${5 - fails === 1 ? "y" : "ies"} left before a short wait.`, true);
  }
  // Show the lock screen. Resolves true when unlocked, false if cancelled (only when cancel is allowed).
  function prompt(c, { title = "Enter your PIN", cancel = false } = {}) {
    if (pending) return Promise.resolve(false);
    cfg = c; entered = "";
    $("lkTitle").textContent = title;
    $("lkCancel").classList.toggle("hidden", !cancel);
    $("lkForgot").classList.toggle("hidden", cancel);
    $("lkBio").classList.toggle("invisible", !c.bio);
    message("");
    dots();
    $("lockDlg").showModal();
    cooling();
    return new Promise((resolve) => { pending = resolve; if (c.bio) tryBio(); });
  }

  // ----- when to lock -----
  let active = null, unlocked = false, hiddenAt = 0, onForgot = null;
  // Remember when the app was last open and unlocked, so reopening or reloading it soon after doesn't ask again.
  function markSeen() {
    if (!active || !unlocked || !forUser(active)) return;
    try { localStorage.setItem(SEEN, JSON.stringify({ email: active, t: Date.now() })); } catch { /* not saved: it just asks next time */ }
  }
  function seenRecently(c, email) {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SEEN) || "null"); } catch { /* ask */ }
    if (!s || s.email !== email || typeof s.t !== "number") return false;
    const away = Date.now() - s.t;
    return away >= 0 && away < Math.max(c.after, GRACE) * 1000;
  }
  function watch(email) {
    active = email || null;
    if (!active) { unlocked = false; try { localStorage.removeItem(SEEN); } catch { /* ignore */ } }
  }
  async function gate(email) {
    watch(email);
    const c = forUser(email);
    if (!c || seenRecently(c, email)) { unlocked = true; markSeen(); return true; }
    unlocked = false;
    return prompt(c);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
    const c = forUser(active);
    if (c && hiddenAt && Date.now() - hiddenAt >= c.after * 1000) { unlocked = false; prompt(c); }
  });
  window.addEventListener("pagehide", markSeen);

  function wire() {
    $("lkPad").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) press(b.dataset.k); });
    document.addEventListener("keydown", (e) => {
      if (!pending || !$("lockDlg").open) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); press("del"); }
    });
    $("lockDlg").addEventListener("cancel", (e) => { e.preventDefault(); if (!$("lkCancel").classList.contains("hidden")) done(false); });
    $("lkCancel").addEventListener("click", () => done(false));
    $("lkForgot").addEventListener("click", () => {
      if (!confirm("Forgot your PIN? You'll be signed out on this device and the app lock will be turned off. Sign in again with Google to continue.")) return;
      store(null); done(false);
      if (onForgot) onForgot();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();

  // ----- set up / change / turn off (used by Settings) -----
  async function enable({ email, name, pin, useBio, after }) {
    if (!/^[0-9]{4,6}$/.test(pin)) throw new Error("Use 4 to 6 digits for your PIN.");
    let bio = null;
    if (useBio) bio = await createBio(email, name);   // first, while the tap still counts as a user gesture
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const c = { email, len: pin.length, salt, hash: await hashPin(pin, salt), bio, after: Number(after) || 0 };
    if (!store(c)) throw new Error("This browser won't let the app save the lock (private browsing?).");
    unlocked = true; markSeen();
    return c;
  }
  function update(email, patch) { const c = forUser(email); if (c) store({ ...c, ...patch }); return forUser(email); }
  function disable() { store(null); }

  return {
    supported, bioAvailable, config: forUser, prompt, gate, watch, enable, update, disable, createBio,
    setForgotHandler(fn) { onForgot = fn; },
  };
})();
