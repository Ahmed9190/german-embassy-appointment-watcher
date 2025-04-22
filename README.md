# 🇩🇪 German Embassy Appointment Watcher Bot 🤖📅

A Telegram bot that **monitors visa appointment availability** on the [German Embassy appointment system](https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=kiga&realmId=1044&categoryId=2149). It uses Puppeteer to interact with the website, solve captchas via human input over Telegram, and notifies you **instantly** when appointments become available.

---

## 🚀 Features

- ✅ Automatically checks for appointment availability every 30 minutes.
- 🧠 Smart captcha solving via human-in-the-loop (Telegram).
- 🔄 `/another` command to refresh captcha without restarting.
- 👁️ Re-checks next month if the current month is fully booked.
- 🔔 Repeated alerts every 5 seconds if an appointment is found — until you reply `OK`.
- 💬 Simple Telegram interface — no need for any dashboard.
- 🧹 Auto cleanup and graceful shutdown support.
- 🧪 Built-in anti-duplication to prevent overlapping runs.

---

## 📸 Live Screenshot (Concept)

> 🖼️ Captcha images like this will be sent to your Telegram:

```
🖼️ New captcha. Reply with the text.
Use /another to get a new one.
```

---

## ⚙️ Requirements

- Node.js 18+
- A Telegram account
- A Telegram bot token ([Create one here](https://t.me/BotFather))
- Your personal Telegram `chat_id`

---

## 📦 Installation

1. **Clone the repo**:

```bash
git clone https://github.com/Ahmed9190/german-embassy-appointment-watcher.git
cd german-embassy-appointment-watcher
```

2. **Install dependencies**:

```bash
npm install
```

3. **Configure environment variables**:

Create a `.env` file in the root folder:

```env
BOT_TOKEN=your_telegram_bot_token
CHAT_ID=your_telegram_chat_id
```

---

## ✅ Usage

### Start the bot:

```bash
node index.js
```

### On startup, it will:

- Send a message to your Telegram with usage instructions.
- Start the first check immediately.
- Schedule future checks every 30 minutes.

---

## 📲 Telegram Commands

| Command     | Description                                             |
| ----------- | ------------------------------------------------------- |
| `/checknow` | Run a manual check immediately. Aborts any current run. |
| `/another`  | Refresh the captcha (clicks refresh or reloads page).   |
| `OK`        | Stop the repeated alerts once an appointment is found.  |

---

## 💡 How It Works

1. The bot opens the [appointment page](https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=kiga&realmId=1044&categoryId=2149) using Puppeteer.
2. It waits for a captcha and sends it to you via Telegram.
3. You reply with the code (e.g. `a4g76z`).
4. The bot submits the captcha:
   - If wrong ➜ asks again.
   - If right ➜ proceeds to check appointments.
5. If an appointment is available:
   - Sends spammy alerts every 5s.
   - Stops when you reply `OK`.

---

## 👨‍💻 Developer Info

### Tech Stack

- **Node.js** — Runtime
- **Puppeteer** — Headless browser automation
- **node-telegram-bot-api** — Telegram API wrapper
- **node-cron** — For scheduled periodic checks

### Folder structure (flat):

```
.
├── index.js        # Main bot logic
├── .env            # Bot token + chat ID
├── package.json    # Dependencies
```

---

## 🛡️ Safety & Limitations

- ❌ This bot does **not solve captchas automatically**.
- ✅ Designed for private use (your own chat ID only).
- 🚫 Never share your `.env` or bot token publicly.
- 🚀 Fully abortable & restart-safe.

---

## 🧪 Development Tips

- To find your Telegram chat ID: [Use this bot](https://t.me/userinfobot)
- Logs appear in your terminal with status updates.
- To test cancellation and retry, try submitting a wrong captcha.

---

## 🧼 Graceful Shutdown

The bot listens for:

- `SIGINT` (Ctrl+C)
- `SIGTERM` (e.g. from Docker or PM2)

And cleans up:

- Telegram listeners
- Captcha intervals
- Open Puppeteer browsers

---

## 📌 Customization Ideas

- Add Slack or email integration.
- Visual dashboard with logs and appointment history.
- Save successful dates to a database.
- Auto-book slot if captcha + form solving is automated.

---

## 📜 License

MIT – free for personal use and tinkering.
