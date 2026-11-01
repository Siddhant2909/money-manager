"use strict";
(() => {
  const { $, api, accountsForm, passwordProblem } = MM;
  const form = accountsForm($("accForm"), [], "register");

  // Already signed in? Go to the app.
  api("session").then((s) => { if (s.authenticated) location.replace("/"); }).catch(() => {});

  $("regForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("regErr");
    err.textContent = "";
    const email = $("email").value.trim();
    const pw = $("password").value, pw2 = $("password2").value;
    if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
    const p = passwordProblem(pw, email);
    if (p) { err.textContent = p; return; }
    if (pw !== pw2) { err.textContent = "The two passwords don't match."; return; }
    const { accounts, error } = form.read();
    if (error) { err.textContent = error; return; }
    $("regBtn").disabled = true;
    try {
      await api("register", { email, password: pw, accounts });
      $("password").value = $("password2").value = "";
      location.replace("/");
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      $("regBtn").disabled = false;
    }
  });
})();
