# Astra Chatbot
Gemini-powered chat with Google sign-in, name onboarding, file/media upload, recent activity and a stop button.

## 1. Google sign-in (one-time)
1. console.cloud.google.com → APIs & Services → **OAuth consent screen** (External) → fill basics → publish.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Under **Authorized JavaScript origins** add `https://YOUR-APP.onrender.com` and `http://localhost:3000`. (No redirect URI needed.)
4. Copy the Client ID → set as `GOOGLE_CLIENT_ID`.

## 2. Deploy on Render
Push to GitHub → Render **New → Blueprint**. Set `GEMINI_API_KEY` and `GOOGLE_CLIENT_ID`. `SESSION_SECRET` is generated automatically.
Deploy first to get your `.onrender.com` URL, then add it to the Google origins above.

## Local
```
npm install
GEMINI_API_KEY=... GOOGLE_CLIENT_ID=... npm start
```
Notes: chat history and the chosen name are stored in the browser, per Google account. Uploads: images, PDF, audio, video and text/code files (4 per message, 8 MB each).

## Telegram Mini App
1. In @BotFather: `/newbot` → copy the bot token → set it in Render as `TELEGRAM_BOT_TOKEN`.
2. `/newapp` → pick the bot → paste your Render URL (or `/setmenubutton` for a chat menu button).
3. Branding: `/setuserpic` → `telegram/bot-avatar.png`, `/setdescriptionpic` → `telegram/bot-banner.png`,
   `/setdescription` and `/setabouttext` → text from `telegram/bot-texts.txt`.
Inside Telegram users are signed in automatically with their Telegram account; Astra then asks what to call them.
