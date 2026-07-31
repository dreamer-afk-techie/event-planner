# Event Planner Supabase Deploy

This version keeps the website as plain HTML, CSS, and JavaScript. Supabase provides the shared database and API.

## 1. Create Supabase Project

1. Go to https://supabase.com/.
2. Create a free project.
3. Open SQL Editor.
4. Paste and run `supabase-schema.sql`.

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

When Supabase is configured, the status pill should say `Live shared data`.

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
- This simple version allows anyone with the site link to create events, vote, finalize, and log practice.
- For stronger control later, add login or an event invite code.
