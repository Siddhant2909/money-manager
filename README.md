# Money Manager

A personal finance web app with these pages:

- **Dashboard:** totals, account balances, month-wise summary and charts.
- **Monthly:** income, expense and transfer entries, plus each account's balance for the month.
- **Investment:** where you've invested.
- **Registration:** a separate page where you set up your bank accounts, credit cards and cash.

It runs on Vercel, with a Neon Postgres database.

## Files

```
money-manager/
├── index.html            sign-in page and the app
├── register.html         registration page (served at /register)
├── styles.css            design (dark, flat)
├── favicon.svg           logo / browser icon
├── apple-touch-icon.png  icon when added to a phone's home screen
├── vercel.json           security headers (CSP, HSTS, etc.)
├── package.json          installs the Postgres driver
├── js/
│   ├── common.js         shared helpers (API calls, formatting, accounts form)
│   ├── app.js            the app
│   └── register.js       registration page
├── vendor/
│   └── chart.umd.min.js  Chart.js 4.5.1 (hosted locally, MIT licence)
└── api/
    └── data.js           server API: sign-in, sessions, accounts, entries
```

## Upgrading from the previous version
1. Upload everything in this folder to your GitHub repository, replacing the old files. Drag the files **and** the `js`, `vendor` and `api` folders onto **Add file → Upload files**, then commit. Vercel redeploys automatically.
2. Sign in with your existing email and password. The app asks you to set up your accounts once: Bank account 1 is required, and Bank account 2, two credit cards and cash are optional.
3. Your earlier data is kept:
   - Each month's salary becomes an **Income** entry named *Salary*.
   - Old expenses stay as they are.
   - Both are marked **Not linked**, so they don't change the balances you enter.
   - To link an old entry to an account, edit it.
4. Optional:
   - Delete `GOOGLE_CLIENT_ID` from Vercel's environment variables. It is no longer used.
   - Everyone is signed out once after this update, because sessions are now stored in the database.

## New installation
1. Upload the files to a new GitHub repository, as above.
2. In Vercel, go to **Add New → Project**, import the repository and click **Deploy**.
3. In Vercel, open **Storage → Create Database → Neon (Postgres)**, connect it to the project, then **Redeploy**.
4. Open `https://<your-app>.vercel.app/register` and create your account.

**Who can register:** by default, only the first account. To allow specific people, set `ALLOWED_EMAILS` (comma-separated) in Vercel, then redeploy.

## How balances work
- **At registration**, enter each bank account's and your cash's current balance, and each card's credit limit and amount currently due.
- **Income** (e.g. salary on the 1st) adds to the account it is received in.
- **Expenses** reduce the bank or cash balance they are paid from, or add to the amount due on a credit card.
- **Transfers** move money between your own accounts. Use them for credit-card bill payments (bank → card) and ATM withdrawals (bank → cash). Transfers are not counted as income or expenditure.
- **Each month starts** from the previous month's closing balance. The Monthly tab shows opening, in, out and closing for every account. The Dashboard shows current balances and, for cards, the amount due and the limit still available.
- **Totals:**
  - Expenditure = expenses not marked Investment.
  - Savings = Income − Expenditure.
  - The Investment tab groups entries marked Investment by the "Invested in" field.

## Security controls
| Area | What's implemented |
|---|---|
| Passwords | Hashed with scrypt and a per-user random salt. Minimum 10 characters, common passwords and the email name are rejected. Comparisons run in constant time. |
| Brute force | The account locks for 15 minutes after 10 wrong passwords. Sign-in and registration attempts are limited per IP (`AUTH_RATE_LIMIT`, default 40 per 10 minutes). Sign-in errors are generic. |
| Sessions | A random 256-bit token is kept in a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict). Only its SHA-256 hash is stored. Sessions expire after 14 days, or after 7 days of inactivity. Each sign-in gets a new session. Signing out deletes the session on the server, and changing your password signs out your other devices. |
| CSRF | Every change needs a per-session token sent in a header. The API also checks the request's origin and accepts JSON bodies only. |
| Injection | Every database query is parameterised. All input is checked against strict allow-lists (amount format, dates, entry types, IDs, text length) and control characters are removed. |
| Access control | Every query is limited to the signed-in user. Database foreign keys stop an entry from pointing at someone else's account, and the server re-checks this. |
| XSS | All user text is escaped before display. A strict Content Security Policy blocks inline and third-party scripts, and the app contains none. Chart.js is hosted with the app. |
| Headers | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy and COOP/CORP on all pages. API responses are never cached. |
| Errors & limits | Errors shown to users are generic, and details go only to the server logs (without your data). Requests over 64 KB are refused, and each database statement times out after 10 seconds. |
| Database connection | TLS with full certificate checking (`sslmode=verify-full`). |

## Forgot your password?
1. In the Neon dashboard (open it from **Vercel → Storage**), go to **SQL Editor** and run:
   ```sql
   update mm_users set pass_hash = 'RESET' where email = 'you@example.com';
   ```
2. Open `/register`, enter the same email and a new password, fill in any bank name, and submit.
3. Your existing accounts and entries are kept, and the account details you entered on the form are ignored.
