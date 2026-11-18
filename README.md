# Track

Ultra-simple team chat plus a Trello-style board in one window. A static single-page app on GitHub Pages, installable as a PWA, backed by Supabase.

- A **workspace** has one chat and one board.
- People join with an invite link or code.
- Two roles: **owner** (rename, delete, remove members) and **member**.
- Chat with images, @mentions, search and full history.
- Board with columns, drag and drop, assignees, due dates, checklists, comments and images.
- Turn any chat message into a card with "Make card".
- Push notifications on phones and desktops, even when Track is closed (optional setup, see below).

## Deploy your own (fork)

1. **Fork** this repo. The app is served at `https://<you>.github.io/<repo-name>/`.
2. **Create a Supabase project** at [supabase.com](https://supabase.com).
3. **Apply the database schema** from your machine:
   ```sh
   npm install
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
4. **Auth settings** in the Supabase dashboard, under Authentication > URL Configuration:
   - Site URL: `https://<you>.github.io/<repo-name>/`
   - Redirect URLs: add the same URL. Confirmation emails send people back here, and Supabase refuses redirects that are not on this list.
   - Optional: under Authentication > Sign In / Providers, turn off "Allow new users to sign up" to make the server invite-only. You then create accounts from the dashboard.
5. **GitHub secrets** in your fork, under Settings > Secrets and variables > Actions, add:
   - `VITE_SUPABASE_URL`: your project URL, for example `https://abcd1234.supabase.co`
   - `VITE_SUPABASE_ANON_KEY`: the **anon** or **publishable** key (Project Settings > API Keys)
6. **Pages**: Settings > Pages > Source: **GitHub Actions**.
7. Push to `main`. The workflow runs the database tests, builds, and deploys.
8. Optional: [set up push notifications](#push-notifications).

A second workflow pings the API twice a week, because Supabase pauses free projects after about a week without activity.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Anon / publishable key only |
| `VITE_VAPID_PUBLIC_KEY` | no | Public Web Push key. Without it, notifications only work while Track is open. |
| `BASE_PATH` | no | URL path the app lives under. Defaults to `/track/`. CI sets it to `/<repo-name>/`. Use `/` for a `<you>.github.io` repo or a custom domain. |

The build **fails on purpose** if either Supabase variable is missing, or if the key is a secret key (`sb_secret_...`) or a JWT with role `service_role`. Those keys bypass all security and would be published inside the JavaScript bundle. If you ever committed or deployed one, rotate it in the Supabase dashboard.

## Local development

```sh
npm install
cp .env.example .env.local   # then fill in your URL and anon key
npm run dev                  # http://127.0.0.1:5501/track/
```

For a fully local backend (needs Docker):

```sh
npx supabase start           # prints a local URL and anon key for .env.local
npm run test:db              # pgTAP tests for the access rules
```

`supabase/config.toml` already allows `http://127.0.0.1:5501/track/` as an auth redirect. When pointing a dev build at a hosted project, add that URL to its Redirect URLs too.

## Security model

The source is public and the anon key ends up in the bundle, so security never depends on either being secret.

- **Row Level Security is the boundary.** Every table has RLS enabled. Policies assume an attacker calls the API directly with the anon key. See `supabase/migrations/` and the tests in `supabase/tests/`.
- Workspaces and memberships can only be created through the `create_workspace` and `join_workspace` functions. Roles can never be changed through the API. Column privileges limit what each update can touch (for example, members can only change their own `last_read_at`, and authors only the `body` of their messages).
- **No secrets in the repo.** `.env` and `.env.*` are gitignored. Never use the service role key in this project.
- **User content is rendered as plain text**, never as HTML or markdown. Supabase stores the session in browser storage, so any script injection could steal it.
- **Content Security Policy** (meta tag in `index.html`, because GitHub Pages cannot set headers) allows scripts only from the app itself and network connections only to `*.supabase.co`. No third-party scripts, fonts, analytics, or CDNs.
- The service worker precaches only the static app shell. Supabase API and auth responses are never cached.

### Self-hosted Supabase

The CSP only allows connections and images from `*.supabase.co`. If your Supabase runs elsewhere, edit `connect-src` and `img-src` in `index.html` to your API origin:

```
connect-src 'self' https://supabase.example.com wss://supabase.example.com; img-src 'self' https://supabase.example.com;
```

## Push notifications

Click the bell in a workspace to turn notifications on. On Android and iOS, install Track to the home screen first.

Without the setup below, notifications only arrive while Track is open in the background. With it, they arrive even when Track is closed. The `push` Edge Function sends them; the database hands it the recipients, so it needs no database access and no service role key.

1. Generate a VAPID key pair, for example with `npx web-push generate-vapid-keys`.
2. Set the function's secrets and deploy it:
   ```sh
   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=https://github.com/<you>/<repo> PUSH_SECRET=<long random string>
   npx supabase functions deploy push --no-verify-jwt
   ```
3. Tell the database where to send new messages. In the SQL editor:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/push', 'push_function_url');
   select vault.create_secret('<the same PUSH_SECRET>', 'push_secret');
   ```
4. Add the **public** key as the GitHub secret `VITE_VAPID_PUBLIC_KEY` and redeploy.

## Storage and cleanup

The Supabase free plan includes 500 MB of database and 1 GB of file storage.

- Images are resized to at most 1600px and re-encoded in the browser before upload, usually to a few hundred KB.
- Deleting a message, card or image deletes the file once nothing else uses it.
- Workspace Settings > Storage shows usage. Above 90% everyone sees a warning, and the owner can delete messages and images older than 30, 90, 180 or 365 days, or remove unused image files.
- Chat history is kept. Only if the database passes 90% of its limit does a nightly job delete the oldest messages until it is back near 75%. If you upgrade your plan, raise `limit_bytes` in `trim_messages_if_full` and `LIMITS` in `src/supabase.ts`.
## Tech

React, TypeScript, Vite, supabase-js, Supabase Edge Functions (Web Push), Pragmatic drag and drop, fractional-indexing, vite-plugin-pwa, plain CSS. Hash-based routing, because GitHub Pages has no SPA fallback.
