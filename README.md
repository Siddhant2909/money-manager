# Money Manager

A personal expense tracker:

- A **Monthly** page for salary, expenses and totals.
- A **Dashboard** with month-wise totals and donut charts.

Data is stored in **Postgres**, using a free Neon database added from Vercel. You sign in with your **email and password**. Everything is hosted on **Vercel**.

## Files

```
money-manager/
├── index.html      the app (what you see)
├── package.json    tells Vercel to install the Postgres driver
└── api/
    └── data.js     the server API (talks to Postgres, handles sign-in)
```

The API creates its tables the first time it runs, so you don't need to run any SQL.

## Setup (about 10 minutes)

### 1. Put the files on GitHub
1. Create a repository (for example `money-manager`) on github.com.
2. Click **Add file → Upload files**.
3. Unzip `money-manager.zip`. Open the `money-manager` folder and drag `index.html`, `package.json` and the `api` folder onto the upload area. Use Chrome or Edge, and drag the items inside the folder, not the folder itself.
4. Check that `api/data.js` appears in the list, then click **Commit changes**.

If you can't drag the folder, click **Add file → Create new file**, type `api/data.js` as the name, paste in the contents of `data.js`, and commit.

### 2. Deploy on Vercel
1. On vercel.com, go to **Add New → Project**, import the repository, leave **Framework Preset** as **Other**, and click **Deploy**.

### 3. Add the Postgres database (Neon)
1. In the Vercel project, open **Storage → Create Database → Neon (Postgres)**. Choose the free plan and connect the database to this project.
2. Vercel adds `DATABASE_URL` for you.
3. Go to **Deployments**, click **⋯ → Redeploy** on the latest deployment, then open the app.

### 4. Create your account
Open the app, enter your email and a password (at least 8 characters), and click **Create account**.

**Who can create an account:**
- **By default,** only the first account can be created. Once your account exists, sign-ups are closed. Create your account straight after deploying.
- **To allow specific people,** add `ALLOWED_EMAILS` in **Vercel → Settings → Environment Variables** (comma-separated emails), then redeploy. Only those emails can create accounts.

If you set `GOOGLE_CLIENT_ID` for the earlier Google sign-in version, you can delete it. It is no longer used.

## Using it
- **Monthly:** pick a month and enter your salary. It saves when you leave the box. Then add expenses (date, name, amount, category, Need/Want/Investment).
  - The category box suggests categories you have used before.
  - Use the pencil and bin icons on a row to edit or delete it. The filters show a filtered total.
- **Totals:**
  - Total Expenditure = sum of amounts, leaving out entries marked Investment.
  - Savings = Salary − Total Expenditure.
  - Total Investment = sum of entries marked Investment.
- **Dashboard:**
  - Totals for all months, and a month-wise table.
  - Donut charts for expenditure by month and savings by month. A month with negative savings shows as 0 in the savings chart.
  - Category-wise expenditure. Investment entries are left out, and expenses with no category show as "Uncategorised".

## Forgot your password?
There is no email reset. In the Neon dashboard (open it from **Vercel → Storage**), go to **SQL Editor** and run:

```sql
delete from mm_users where email = 'you@example.com';
```

Then open the app and use **Create account** with the same email. Your expenses and salaries are kept, because they are linked to your email.

## Security notes
- Passwords are stored only as salted scrypt hashes, never in plain text.
- After 10 wrong passwords in a row, the account is locked for 15 minutes.
- Your session lasts 30 days, in a secure HttpOnly cookie. The key that signs the cookie is created automatically and kept in your database.
- Each account sees only its own data. If you delete an account, it is signed out on its next request.
