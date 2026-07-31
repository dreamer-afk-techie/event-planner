# Event Planner Supabase Deploy

This version keeps the website as plain HTML, CSS, and JavaScript. Supabase provides the shared database and API.

## 1. Create Supabase Project

1. Go to https://supabase.com/.
2. Create a free project.
3. Open SQL Editor.
4. Paste and run `supabase-schema.sql`.
5. In **Authentication → Providers**, enable **Anonymous Sign-Ins**. No email provider or redirect URL is needed.
6. Enable CAPTCHA for anonymous sign-ins before sharing a public link; Supabase recommends it to reduce automated account creation.

## 2. Add Frontend Config

Open `public/config.js` and set:

```js
window.EVENT_PLANNER_SUPABASE = {
  url: "https://YOUR_PROJECT_ID.supabase.co",
  anonKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
};
```

Use the publishable/anon key only. Never put the service-role secret key in frontend files.

## 3. Test Locally

Run the local server:

```sh
python3 server.py
```

Open:

```text
http://127.0.0.1:8010/
```

When Supabase is configured, the app creates an anonymous Supabase account without collecting an email address. The event owner creates a code of at least 12 characters and shares it privately. Participants enter that code to join the event.

Anonymous accounts are stored only in the browser. If someone signs out, clears browser data, or uses another device, they must enter the event code again.

## Existing data

The security migration adds an owner and a protected event code to each new event. Existing events do not have these values automatically and will be hidden after the migration. Recreate them after applying the migration.

## 4. Upload The Frontend

Upload the contents of `public/` to a static host:

- Netlify manual deploy
- Cloudflare Pages direct upload
- Vercel
- GitHub Pages

For the simplest manual deploy, zip the contents inside `public/`, not the `public` folder itself.

## Security Notes

- Supabase Row Level Security is enabled in `supabase-schema.sql`.
- The frontend uses only the publishable/anon key.
- GitHub Pages serves a public frontend; its publishable Supabase key is intentionally visible. Access is enforced by Supabase Auth and Row Level Security.
- Never add a Supabase secret/service-role key to `public/config.js`.
