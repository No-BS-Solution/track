# Tack

Ultra-simple team chat plus a Trello-style board in one window. A static single-page app on GitHub Pages, installable as a PWA, backed by Supabase.

- A **workspace** has one chat and one board.
- People join with an invite link or code.
- Two roles: **owner** (rename, delete, remove members) and **member**.
- Turn any chat message into a card with "Make card".

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

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Anon / publishable key only |
| `BASE_PATH` | no | URL path the app lives under. Defaults to `/tack/`. CI sets it to `/<repo-name>/`. Use `/` for a `<you>.github.io` repo or a custom domain. |

The build **fails on purpose** if either Supabase variable is missing, or if the key is a secret key (`sb_secret_...`) or a JWT with role `service_role`. Those keys bypass all security and would be published inside the JavaScript bundle. If you ever committed or deployed one, rotate it in the Supabase dashboard.

## Local development

```sh
npm install
cp .env.example .env.local   # then fill in your URL and anon key
npm run dev                  # http://127.0.0.1:5501/tack/
```

For a fully local backend (needs Docker):

```sh
npx supabase start           # prints a local URL and anon key for .env.local
npm run test:db              # pgTAP tests for the access rules
```

`supabase/config.toml` already allows `http://127.0.0.1:5501/tack/` as an auth redirect. When pointing a dev build at a hosted project, add that URL to its Redirect URLs too.

## Security model

The source is public and the anon key ends up in the bundle, so security never depends on either being secret.

- **Row Level Security is the boundary.** Every table has RLS enabled. Policies assume an attacker calls the API directly with the anon key. See `supabase/migrations/` and the tests in `supabase/tests/`.
- Workspaces and memberships can only be created through the `create_workspace` and `join_workspace` functions. Roles can never be changed through the API. Column privileges limit what each update can touch (for example, members can only change their own `last_read_at`, and authors only the `body` of their messages).
- **No secrets in the repo.** `.env` and `.env.*` are gitignored. Never use the service role key in this project.
- **User content is rendered as plain text**, never as HTML or markdown. Supabase stores the session in browser storage, so any script injection could steal it.
- **Content Security Policy** (meta tag in `index.html`, because GitHub Pages cannot set headers) allows scripts only from the app itself and network connections only to `*.supabase.co`. No third-party scripts, fonts, analytics, or CDNs.
- The service worker precaches only the static app shell. Supabase API and auth responses are never cached.

### Self-hosted Supabase

The CSP only allows connections to `*.supabase.co`. If your Supabase runs elsewhere, edit the `connect-src` in `index.html` to your API origin, for both `https://` and `wss://`:

```
connect-src 'self' https://supabase.example.com wss://supabase.example.com;
```

## Notifications

Click "Enable notifications" in a workspace to get a browser notification for new messages while the tab is in the background. On iOS this only works once Tack is installed to the home screen.

## Tech

React, TypeScript, Vite, supabase-js, Pragmatic drag and drop, fractional-indexing, vite-plugin-pwa, plain CSS. Hash-based routing, because GitHub Pages has no SPA fallback.
