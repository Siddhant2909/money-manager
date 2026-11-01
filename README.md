# Money Manager

A personal finance web app with these pages:

- **Sign in:** a single **Continue with Google** button. There are no passwords and no registration form. The first time you continue with Google, your account is created.
- **Monthly** (the home page): the month's entries, grouped by day, with search and a type filter. **Add entry** opens a form; click any entry to edit or delete it. Account balances for the month are in a collapsible section below. On desktop, press `N` to add an entry.
- **Overview:** how much money you have now (banks + cash − card dues) and how much is invested; this month against last month; your accounts (tap one to edit it); spending by category for this month or all time; a 6-month income vs spending chart; and every month in a fold-away table.
- **Plan:** your monthly budget, budgets by category, and recurring payments (rent, maid, cook, SIPs, RDs, subscriptions, salary).
- **Investments:** your portfolio. It shows the total, this year and this month, a split by type (Mutual fund, Stocks, Gold, FD, RD, PPF, NPS, Other), each holding with its entries, and a month-by-month chart. **Add investment** opens the entry form with **Invest** selected.
- **Settings** (click your name, top right): your profile, your accounts and sign out. New users start here to add their first bank account. Tap an account to edit or remove it, or use **Add account** for a second bank account or a credit card.

The design is dark. It runs on Vercel, with a Neon Postgres database.

## Files

```
money-manager/
├── index.html            sign-in page and the app
├── manifest.webmanifest  lets phones install the app on the home screen
├── styles.css            design (dark)
├── favicon.svg           logo / browser icon
├── apple-touch-icon.png  icon when added to an iPhone home screen
├── icon-192.png, icon-512.png  icons for installing on Android
├── vercel.json           security headers (CSP, HSTS, etc.) and the /auth/google routes
├── package.json          installs the Postgres driver
├── js/
│   ├── common.js         shared helpers (API calls, formatting)
│   └── app.js            the app
├── vendor/
│   └── chart.umd.min.js  Chart.js 4.5.1 (hosted locally, MIT licence)
└── api/
    └── data.js           server API: Google sign-in, sessions, accounts, entries, budgets and
                          recurring payments
```

## Setup
1. Upload the files to a GitHub repository.
2. In Vercel, go to **Add New → Project**, import the repository and click **Deploy**.
3. In Vercel, open **Storage → Create Database → Neon (Postgres)** and connect it to the project.
4. Set up Google sign-in (below), then **Redeploy**.
5. Open your app and click **Continue with Google**. Then add your bank account in Settings.

### Google sign-in
Sign-in needs a Google OAuth client. It's free and needs no billing account.

1. In the [Google Cloud console](https://console.cloud.google.com/), choose or create a project.
2. Open **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles). Choose **External** and enter the app name and your email. Under **Audience**, publish the app, or add yourself as a test user.
3. Go to **Clients** (or **Credentials**) → **Create client** → **Web application**. Under **Authorised redirect URIs**, add:
   `https://<your-app>.vercel.app/auth/google/callback`
   If you use a custom domain, add that one too.
4. In Vercel, go to **Settings → Environment Variables** and add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client. Then **Redeploy**.

Optional settings:
- `APP_URL` (e.g. `https://money.example.com`) makes the redirect URI always use that domain.
- `ALLOWED_EMAILS` (comma-separated) limits sign-up to those Google accounts. If it isn't set, anyone can sign up.
- `AUTH_RATE_LIMIT` sets how many sign-in attempts are allowed per IP every 10 minutes (default 40).

**Who can create an account:** anyone with a Google account. Each person gets their own accounts and entries, and nobody can see anyone else's data. To limit sign-up to specific people, set `ALLOWED_EMAILS` (comma-separated), then redeploy. A Google account whose email matches an existing account always signs in to that account, and that account's data is kept.

If your Google OAuth consent screen is still in **Testing**, Google only lets the test users you listed sign in. To let anyone sign in, open **Google Auth Platform → Audience** and click **Publish app**. For basic sign-in (name and email), Google doesn't require a review.

## Budgets and recurring payments
- **Monthly budget:** one limit for everything you spend in a month, not counting investments or transfers. The Monthly page shows how much is left.
- **Category budgets:** split the monthly budget by category (e.g. Groceries ₹8,000). Each one tracks the expenses in that category. Category names match the categories on your entries, ignoring capitals. Budgets apply to every month until you change them.
- **Recurring payments:** add rent, a maid or cook, SIPs, RDs, EMIs, subscriptions or salary once, with the date it's next due.
  - **Automatic** ones are added as entries on their date. The app adds them when it's opened, and catches up on any missed months.
  - Turn off **Add automatically** to confirm each month yourself. Those payments appear under *Recurring this month* on the Monthly page, with **Add** and **Skip** buttons.
  - To make an existing entry repeat, turn on **Repeat every month** when adding it.
  - A payment due on the 29th, 30th or 31st moves to the last day of shorter months.
  - Deleting a recurring payment keeps the entries it already added.

## How balances work
- **In Settings**, enter each bank account's and your cash's current balance, and each card's credit limit and amount currently due.
- **Income** (e.g. salary on the 1st) adds to the account it is received in.
- **Expenses** reduce the bank or cash balance they are paid from, or add to the amount due on a credit card.
- **Transfers** move money between your own accounts. Use them for credit-card bill payments (bank → card) and ATM withdrawals (bank → cash). Transfers are not counted as income or expenditure.
- **Each month starts** from the previous month's closing balance. The Monthly page shows opening, in, out and closing for every account. Overview and Settings show current balances and, for cards, the amount due and the limit still available.
- **Totals:**
  - Expenditure = expenses (investments aren't expenses).
  - Savings = Income − Expenditure.
  - **Invest** is its own entry type. Money leaves the bank, cash or card account it's paid from, but it isn't counted as spending, in Savings or in budgets. It's counted under Invested.
  - Older expenses that were marked *Investment* are left as they were. They're still counted under Invested and shown on the Investments page, where their type is worked out from what was typed in "Invested in".

Entries from very old versions (before accounts existed) are marked **Not linked** and don't change balances. To link one to an account, edit it.

## Security controls
| Area | What's implemented |
|---|---|
| Sign-in | Google only, so there are no passwords to guess, reuse or leak. The server runs the OAuth 2.0 authorization code flow with PKCE and a one-time `state` value kept in a short-lived HttpOnly cookie. No Google scripts are loaded, so the strict CSP is unchanged. The ID token is fetched directly from Google over TLS, and its issuer, audience, expiry and `email_verified` are checked. Sign-in attempts are limited per IP (`AUTH_RATE_LIMIT`). |
| Sessions | A random 256-bit token is kept in a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict). Only its SHA-256 hash is stored. Sessions expire after 14 days, or after 7 days of inactivity. Each sign-in gets a new session, and signing out deletes the session on the server. |
| CSRF | Every change needs a per-session token sent in a header. The API also checks the request's origin and accepts JSON bodies only. |
| Injection | Every database query is parameterised. All input is checked against strict allow-lists (amount format, dates, entry types, IDs, text length) and control characters are removed. |
| Access control | Every query is limited to the signed-in user. Database foreign keys stop an entry from pointing at someone else's account, and the server re-checks this. |
| XSS | All user text is escaped before display. A strict Content Security Policy blocks inline and third-party scripts, and the app contains none. Chart.js is hosted with the app. |
| Headers | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy and COOP/CORP on all pages. API responses are never cached. |
| Errors & limits | Errors shown to users are generic, and details go only to the server logs (without your data). Requests over 64 KB are refused, and each database statement times out after 10 seconds. |
| Database connection | TLS with full certificate checking (`sslmode=verify-full`). |
