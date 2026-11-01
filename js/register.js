"use strict";
(() => {
  const { $, api, passwordProblem, takeAuthError } = MM;
  const err = $("regErr");
  err.textContent = takeAuthError();

  // Already signed in? Go to the app. Show Google sign-up if it's set up.
  api("session").then((s) => { if (s.authenticated) location.replace("/"); }).catch(() => {});
  api("config").then((c) => { $("googleWrap").classList.toggle("hidden", !c.google); }).catch(() => {});

  $("regForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const name = $("name").value.trim();
    const email = $("email").value.trim();
    const pw = $("password").value, pw2 = $("password2").value;
    if (!name) { err.textContent = "Enter your name."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
    const p = passwordProblem(pw, email);
    if (p) { err.textContent = p; return; }
    if (pw !== pw2) { err.textContent = "The two passwords don't match."; return; }
    $("regBtn").disabled = true;
    try {
      await api("register", { name, email, password: pw });
      $("password").value = $("password2").value = "";
      location.replace("/");   // the app asks for bank accounts and cards on first sign-in
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      $("regBtn").disabled = false;
    }
  });
})();
