# Going live with real Meta data — step-by-step checklist

This guide is for the person setting up the portal. You need admin access to Suroskie's Meta Business portfolio, your Vercel project and your GitHub repository. Allow about an hour.

> **What has and hasn't been verified.** All connection, sync and access code has been tested against a local *mock* of Meta's API (148 automated tests). Against live Meta, the only thing checked so far is that Meta's servers accept the way the portal sends its access token. **Nobody has run it with a real token yet.** Part E is that real test, and it's what confirms everything works.

You can connect Meta in **two ways**. Both are supported; pick one:

| | **System-user token (recommended)** | **Facebook Login** |
|---|---|---|
| Who it belongs to | A non-human "system user" in your Business | The admin who clicks the button |
| Expiry | Can be set to **never** | About 60 days, then reconnect |
| Breaks when | The token is deleted | That person leaves or loses access to the ad account |
| Best for | Everyday reporting | A quick start, or if you can't create system users |

---

## Part A — Meta for Developers: create the app (both methods)

1. Go to **https://developers.facebook.com/apps** and click **Create app**.
2. When asked what the app is for, choose the option for **ads / Marketing API**. Choose app type **Business** if asked.
3. Connect the app to **Suroskie's Business portfolio**.
4. In the app dashboard, add the product **Marketing API**.
5. Open **App settings → Basic**. Copy the **App ID** and the **App secret** (click *Show*). Keep both somewhere safe for Part C.
6. Recommended: open **App settings → Advanced** and turn on **Require app secret**. The portal signs every call, so this is safe.
7. **Access level.** Your ad accounts belong to Suroskie's own Business, so the default **Standard Access** for `ads_read` should be enough. **No App Review** is needed for this. You'd only need App Review and business verification ("Advanced Access") to read ad accounts owned by *another* business.

Only for **Facebook Login** (skip if you use a system-user token):

8. Add the product **Facebook Login for Business**.
9. Under its **Settings**, add this **Valid OAuth Redirect URI** (use your real portal address):
   `https://suroskie-portal-source-main.vercel.app/api/v1/admin/meta/oauth/callback`
10. Under **Configurations**, create one:
    - token type: *User access token*
    - permissions: **ads_read** and **business_management**

    Copy its **Configuration ID** for Part C (`META_LOGIN_CONFIG_ID`).
11. While the app is in **Development** mode, only people with a role on the app (**App roles → Roles**: Admin, Developer or Tester) can complete Facebook Login. Add the admin who will click the button.

Permissions you do **not** need: `read_insights` (that's for Page insights, not ads), and anything with "manage" or "write". The portal only reads.

## Part B — Meta Business Settings: system user and token (system-user method)

1. Go to **https://business.facebook.com/settings**.
2. **Users → System users → Add.**
   - Name: `Suroskie Portal`
   - Role: **Employee**
3. Select the new system user → **Assign assets → Ad accounts**. Tick each ad account the portal should report on and give **only "View performance"**. Don't give "Manage campaigns"; the portal never changes ads.
4. Still on the system user, **Assign assets → Apps**. Choose the app from Part A.
5. Click **Generate new token**:
   - **App:** your app from Part A
   - **Token expiration:** **Never**
   - **Permissions:** tick **ads_read** and **business_management**
6. Copy the token. **Meta shows it only once.** Don't email it or paste it into any chat. You'll paste it directly into the portal in Part D.

## Part C — Vercel and GitHub settings

**Vercel → your project → Settings → Environment Variables (Production):**

| Variable | Value |
|---|---|
| `META_APP_ID` | App ID from Part A |
| `META_APP_SECRET` | App secret from Part A |
| `META_API_VERSION` | `v24.0` (leave as is) |
| `META_LOGIN_CONFIG_ID` | Configuration ID from Part A step 10 (*Facebook Login only*; otherwise leave empty) |
| `DEMO_MODE` | `false` |
| `APP_URL` and `BETTER_AUTH_URL` | `https://suroskie-portal-source-main.vercel.app` (always open the portal through this exact address) |
| `CRON_SECRET` | keep the existing value |
| `TOKEN_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL` | keep the existing values (changing `TOKEN_ENCRYPTION_KEY` makes saved Meta tokens unreadable) |

**Vercel → Settings → Build and Deployment → Build Command.** ⚠️ Change it to:

```
npx prisma migrate deploy && npm run db:seed && npm run build
```

i.e. **remove `npm run demo:seed`**. Demo seeding deliberately refuses to run once a real ad account exists, so leaving it in makes every later deploy **fail**.

Then **redeploy**. To remove the old demo creators and demo accounts once, either run `npm run demo:clear` from a computer with `DATABASE_URL` set, or temporarily add `&& npm run demo:clear` to the build command for one deploy and then remove it again. Demo data is never shown while `DEMO_MODE=false`, but the demo creators would still appear in creator lists until cleared.

**GitHub → your repository → Settings → Secrets and variables → Actions:**

| Secret | Value |
|---|---|
| `APP_URL` | `https://suroskie-portal-source-main.vercel.app` |
| `CRON_SECRET` | the same value as in Vercel |

The workflow `.github/workflows/sync-cron.yml` then syncs **every hour** and processes the import queue **every 15 minutes**.

- On a **public** repo this is free.
- On a **private** repo it uses about 3,600 Actions minutes a month. GitHub Free includes 2,000. See the note in `docs/DEPLOYMENT.md` for cheaper options.
- GitHub can delay scheduled runs by a few minutes; that's normal.

## Part D — Connect in the portal

1. Sign in as the **Super Admin** and open **Integrations**.
2. **Readiness** should show a ✅ for *Meta app credentials*.
3. Connect:
   - **System-user token:** in **Option A**, paste the token from Part B and click **Validate & connect**.
   - **Facebook Login:** click **Continue with Facebook** in **Option B**, approve, and you're sent back to Integrations.

   Either way you should see *"Connected. N ad account(s) found"*. The token is checked with Meta, encrypted and never shown again.
4. In the **Ad accounts** list on the same page, switch **Sync** on for each account you want.
5. Open **Ad Accounts** and click **Sync now**. Under **Recent sync jobs**:
   - the *structure* and *insights* jobs should reach **succeeded** within a few minutes;
   - the full history (up to 37 months) keeps importing in the background over the following hours.
6. **Facebook Login only:** Integrations shows the token's expiry date and turns amber 7 days before. Reconnect before then.

## Part E — Test plan (confirms it really works)

Do these in order and note the result of each.

| # | Step | Expected |
|---|---|---|
| 1 | Part D steps 3–5 | Connection shows **active**; account health **ok**; structure and insights jobs **succeeded** |
| 2 | **Settings → Metric catalogue** | Every metric says **supported**. If any say *unsupported*, send the list (it means Meta rejected a field for your account or API version). |
| 3 | Pick one ad and one finished day (e.g. yesterday). In **Ads Manager**, set the same day and the account's time zone, and keep each ad set's own attribution setting. Compare with **Campaigns → Ads** for that day. | **Amount spent, Impressions, Link clicks, Purchases, Purchase conversion value, ROAS** match. Today's numbers can differ while Meta is still processing. |
| 4 | **Creatives → Creator mapping → Needs review** | Your real ads are listed. Create two creators, assign a few ads to each, and assign one ad to the wrong creator then correct it. The ad's **history** shows both changes. |
| 5 | **User Management → Invite user**: role **Content Team Manager**, *Selected creators only* = creator 1, and in Metrics set **Amount spent** to *Deny*. Open the invite link in a **private/incognito window** and set a password. | The user signs in successfully |
| 6 | As that user: Overview, Creators, Creatives | Only creator 1 and its ads appear. **No Amount spent, CPM, CPC or cost-per-x** anywhere. No User Management, Integrations or Settings in the menu. |
| 7 | As that user, change the address bar to creator 2's page: `/creators/<creator-2-id>` (copy the id from the admin's address bar) | *"Creator not found"*, with no data |
| 8 | As that user, **Reports → Creative report** download | The CSV has only creator 1's ads and no spend column. As admin, **Audit Logs** shows the `export.csv` entry. |
| 9 | As admin, invite a **Marketing Manager** with *Selected ad accounts* = one account (if you have two) | They see campaigns from that account only |
| 10 | As admin, **suspend** the test user | Their open browser session stops working on the next click |
| 11 | Wait for the next hour mark (+ a few minutes) | GitHub → **Actions** shows a green *Scheduled sync* run, and the portal's "Synced … ago" badge updates |

If step 1, 2 or 3 fails, take a screenshot of **Ad Accounts → Recent sync jobs** (it contains Meta's error message and a trace id) and share it. **Never share the token.**

## What to watch afterwards

| Situation | What it means | What to do |
|---|---|---|
| An account shows **failing** with "token expired" | The token expired or was revoked | Reconnect (Part D) |
| Account shows **rate limited** | Meta is throttling; the portal resumes by itself | Nothing. If it happens daily, consider Advanced Access. |
| A sync job failed with "Meta no longer keeps data for this date range" | That window is older than Meta's 37-month retention | Harmless |
| Some ads have no thumbnail | Meta refused that creative (deleted, or owned by another business) | Reporting for those ads is unaffected |
