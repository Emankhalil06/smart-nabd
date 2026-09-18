# Smart Nabd 2.0 — Accounts + PostgreSQL + Gemini

This package keeps the existing Smart Nabd interface while adding:

- Email/password registration and login.
- Secure server-side password hashing with bcryptjs.
- HttpOnly, SameSite session cookies.
- PostgreSQL-backed users and sessions.
- Free/Premium plan field ready for future billing integration.
- Configurable daily AI limits (default: Free 10, Premium 100).
- Server-side Gemini 3.6 Flash only; the Gemini key is never exposed to the browser.
- Existing medical UI and AI workflows preserved.
- Medical inputs are not written to PostgreSQL by this authentication layer; existing browser-local features remain local until a separate data-storage design is added.

## Required Render environment variables

On the `smart-nabd` web service, add:

- `GEMINI_API_KEY` = your existing Gemini API key
- `DATABASE_URL` = the **Internal Database URL** from `smart-nabd-db`
- `NODE_ENV` = `production`

Optional:

- `FREE_DAILY_LIMIT=10`
- `PREMIUM_DAILY_LIMIT=100`
- `RATE_LIMIT_PER_MINUTE=20`
- `SESSION_DAYS=30`
- `DATABASE_SSL=false` for Render internal PostgreSQL unless your database setup specifically requires SSL.

## Database

The server automatically creates these tables on startup:

- `users`
- `sessions`
- `ai_usage`

No manual SQL migration is required for the first deployment.

## Deploy

1. Replace the old `index.html`, `server.js`, `package.json`, `.env.example`, `.gitignore`, and `README.md` in the GitHub repository with this package.
2. Add `DATABASE_URL` to the Render service using the internal PostgreSQL URL.
3. Keep the existing `GEMINI_API_KEY` secret on Render.
4. Commit/push to `main` and wait for Render to redeploy.
5. Open the live site and create a test account.

## Important production note

The current database is suitable for testing. Render's Free PostgreSQL databases have a limited lifetime according to the current Render plan. Before a real commercial launch, use a persistent paid database and complete privacy, security, medical-data governance, Terms, and billing work.
