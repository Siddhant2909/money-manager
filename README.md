# Money Manager

A personal expense tracker:

- A **Monthly** page for salary, expenses and totals.
- A **Dashboard** with month-wise totals and donut charts.

How it runs:

- Data is stored in **Postgres**, using a free Neon database added from Vercel.
- You sign in with **Google**, and only the email addresses you list are allowed in.
- Everything is hosted on **Vercel**. No other service is involved.

## Files

```
money-manager/
├── index.html      the app (what you see)
├── package.json    tells Vercel to install the Postgres driver
└── api/
    └── data.js     the server API (talks to Postgres, checks Google sign-in)
```

The API creates its tables the first time it runs, so you don't need to run any SQL.

## Setup (about 20 minutes)

### 1. Put the files on GitHub
1. On github.com, create a new repository named `money-manager`. It can be private.
2. Upload the files, keeping the `api` folder:
   - **From a laptop:** unzip `money-manager.zip`, click **uploading an existing file**, drag in `index.html`, `package.json` and the `api` folder, then click **Commit changes**.
   - **From a phone:** use **Add file → Upload files** for `index.html` and `package.json`. Then use **Add file → Create new file**, type the name `api/data.js` (the slash creates the folder), paste in the contents of `data.js`, and commit.

### 2. Deploy on Vercel
1. On vercel.com, sign in with GitHub. Go to **Add New → Project** and import `money-manager`.
2. Leave **Framework Preset** as **Other** and click **Deploy**.
3. Note your address, for example `https://money-manager-abc.vercel.app`. Until you finish the steps below, the app shows "Setup is not finished".

### 3. Add the Postgres database (Neon)
1. In the Vercel project, open **Storage → Create Database → Neon (Postgres)**. Accept the free plan and connect the database to this project.
2. Vercel adds the `DATABASE_URL` setting for you.

### 4. Create the Google sign-in client
1. Open console.cloud.google.com and create a project, for example `money-manager`.
2. Open **Google Auth Platform** (also listed as *APIs & Services → OAuth consent screen*) and click **Get started**:
   - App name: Money Manager, plus your email as the support email.
   - Audience: **External**.
   - Finish the wizard.
3. Under **Audience → Test users**, add your Gmail address.
4. Under **Clients → Create client**, choose **Web application**.
   - Under **Authorized JavaScript origins**, add your Vercel address, for example `https://money-manager-abc.vercel.app`.
   - Click **Create** and copy the **Client ID**.

### 5. Add the settings in Vercel and redeploy
In the Vercel project, open **Settings → Environment Variables** and add:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 4 |
| `ALLOWED_EMAILS` | your Gmail address. To allow more than one, separate them with commas. |

Then go to **Deployments**, open the latest deployment, click **⋯ → Redeploy**, and open the app. Use **Sign in with Google**.

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

## Security notes
- Only Google accounts listed in `ALLOWED_EMAILS` can sign in. If you remove an email from the list, that person is signed out on their next request. Each account sees only its own data.
- The server checks every Google sign-in token: the signature, that it was issued for your Client ID, the expiry date, and that the email is verified.
- Your session lasts 30 days, in a secure HttpOnly cookie. The key that signs the cookie is created automatically and kept in your database.
