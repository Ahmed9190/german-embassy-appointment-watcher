import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import puppeteer from "puppeteer";
import { Buffer } from "node:buffer"; // Explicit import for Buffer

// --- Constants ---
const CAPTCHA_TIMEOUT_MS = 30 * 1000; // 30 seconds
const PAGE_NAVIGATION_TIMEOUT_MS = 29 * 60 * 1000; // 29 minutes
const NOTIFICATION_INTERVAL_MS = 5 * 1000; // 5 seconds
const CRON_SCHEDULE = "*/30 * * * *"; // Every 30 minutes
const APPOINTMENT_URL =
  "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=kiga&realmId=1044&categoryId=2149";
const CAPTCHA_SELECTOR =
  "#appointment_captcha_month > div:nth-child(1) > captcha > div";
const CAPTCHA_INPUT_SELECTOR = "#appointment_captcha_month_captchaText";
const CAPTCHA_REFRESH_SELECTOR = "#appointment_captcha_month_refreshcaptcha";
const NEXT_MONTH_BUTTON_SELECTOR =
  "#content > div.wrapper > h2:nth-child(3) > a:nth-child(2)";
const NO_APPOINTMENTS_TEXT = "Unfortunately, there are no appointments";
const WRONG_CAPTCHA_TEXT = "The entered text was wrong";

// --- Environment Variable Validation ---
const { BOT_TOKEN, CHAT_ID } = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error(
    "Error: BOT_TOKEN and CHAT_ID environment variables are required."
  );
  process.exit(1); // Exit if essential variables are missing
}

// --- Bot Initialization ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- State Management ---
let state = {
  isRunning: false, // Is a check currently running?
  isWaitingForCaptcha: false, // Is the bot waiting for user's captcha input?
  spamInterval: null, // Interval ID for "appointment available" notifications
  browser: null, // Puppeteer browser instance
  page: null, // Puppeteer page instance
  currentAbortController: null, // AbortController for the current check
  captchaMessageListener: null, // Reference to the active message listener for captcha
};

// --- Helper Functions ---

/**
 * Sends a message safely, catching potential Telegram API errors.
 * @param {string} text - The message text.
 */
async function safeSendMessage(text) {
  try {
    await bot.sendMessage(CHAT_ID, text);
  } catch (error) {
    console.error(`Failed to send message: ${error.message}`);
  }
}

/**
 * Sends a photo safely, catching potential Telegram API errors.
 * @param {Buffer} photoBuffer - The photo buffer.
 * @param {TelegramBot.SendPhotoOptions} options - Send photo options.
 */
async function safeSendPhoto(photoBuffer, options) {
  try {
    await bot.sendPhoto(CHAT_ID, photoBuffer, options);
  } catch (error) {
    console.error(`Failed to send photo: ${error.message}`);
  }
}

/**
 * Cleans up resources like browser, page, and intervals.
 */
async function cleanupResources() {
  console.log("🧹 Cleaning up resources...");
  if (state.spamInterval) {
    clearInterval(state.spamInterval);
    state.spamInterval = null;
  }
  if (state.captchaMessageListener) {
    bot.removeListener("message", state.captchaMessageListener);
    state.captchaMessageListener = null;
  }
  if (state.browser) {
    try {
      await state.browser.close();
    } catch (closeError) {
      console.error(`Error closing browser: ${closeError.message}`);
    }
  }
  state.browser = null;
  state.page = null;
  state.isWaitingForCaptcha = false;
  state.isRunning = false; // Mark as not running AFTER cleanup
  state.currentAbortController = null;
  console.log("🧼 Cleanup complete.");
}

/**
 * Extracts captcha image, sends it via Telegram, and waits for user reply.
 * Handles potential timeouts and abort signals.
 * @param {AbortSignal} signal - The AbortSignal to allow cancellation.
 * @returns {Promise<string>} Resolves with the user's captcha text.
 * @throws {Error} If captcha extraction fails, Telegram interaction fails, or operation is aborted.
 */
async function getCaptchaFromUser(signal) {
  if (!state.page) throw new Error("Page is not initialized.");
  state.isWaitingForCaptcha = true;

  try {
    // Wait for captcha element
    await state.page.waitForSelector(CAPTCHA_SELECTOR, {
      timeout: CAPTCHA_TIMEOUT_MS,
      signal, // Pass signal here
    });

    // Extract base64 image data
    const base64 = await state.page.$eval(CAPTCHA_SELECTOR, (el) => {
      const bg = el.style.background;
      const match = bg.match(/base64,([^"]+)/);
      return match ? match[1] : null;
    });

    if (!base64) {
      throw new Error("Could not extract base64 data from captcha element.");
    }
    const buf = Buffer.from(base64, "base64");

    // Send captcha photo to user
    await safeSendPhoto(buf, {
      caption:
        "🖼️ New captcha. Reply with the text.\nUse /another to get a new one.",
    });

    // Wait for user's reply
    return new Promise((resolve, reject) => {
      // Listener to handle user messages
      const messageHandler = (msg) => {
        // Check if the message is from the correct chat and is a potential captcha code
        if (
          String(msg.chat.id) === CHAT_ID &&
          msg.text &&
          /^[0-9A-Za-z]+$/.test(msg.text.trim())
        ) {
          cleanupListener();
          resolve(msg.text.trim());
        }
      };

      // Listener for abort signal
      const abortHandler = () => {
        cleanupListener();
        reject(new Error("Captcha request aborted."));
      };

      // Function to remove listeners
      const cleanupListener = () => {
        bot.removeListener("message", messageHandler);
        signal.removeEventListener("abort", abortHandler);
        state.captchaMessageListener = null; // Clear the reference
        state.isWaitingForCaptcha = false;
      };

      // Register listeners
      bot.on("message", messageHandler);
      signal.addEventListener("abort", abortHandler, { once: true });
      state.captchaMessageListener = messageHandler; // Store reference for potential cleanup
    });
  } catch (error) {
    state.isWaitingForCaptcha = false; // Ensure flag is reset on error
    if (error.name === "AbortError") {
      console.log("Captcha request explicitly aborted.");
    } else {
      console.error(`Error during captcha process: ${error.message}`);
    }
    throw error; // Re-throw the error to be caught by runCheck
  }
}

/**
 * Notifies the user repeatedly until they acknowledge with "OK".
 * @param {string} message - The notification message.
 */
async function notifyAvailable(message) {
  if (state.spamInterval) return; // Already notifying

  await safeSendMessage(message); // Send initial message

  state.spamInterval = setInterval(
    () => safeSendMessage(message),
    NOTIFICATION_INTERVAL_MS
  );

  // Listener to stop notifications
  const stopHandler = (msg) => {
    if (String(msg.chat.id) === CHAT_ID && msg.text?.toUpperCase() === "OK") {
      clearInterval(state.spamInterval);
      state.spamInterval = null;
      bot.removeListener("message", stopHandler);
      safeSendMessage("🆗 Got it - stopping alerts.");
    }
  };
  bot.on("message", stopHandler);
}

/**
 * Checks if the page content indicates no appointments are available.
 * @returns {Promise<boolean>} True if no appointments are available, false otherwise.
 * @throws {Error} If the page is not initialized.
 */
async function checkForNoAppointments() {
  if (!state.page) throw new Error("Page is not initialized.");
  try {
    // More robust check: wait for body, then evaluate
    await state.page.waitForSelector("body", { timeout: 5000 });
    return await state.page.evaluate((text) => {
      // Use XPath for potentially more reliable text finding
      const result = document.evaluate(
        `//text()[contains(.,'${text}')]`,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      return result.snapshotLength > 0;
    }, NO_APPOINTMENTS_TEXT);
  } catch (error) {
    console.error(`Error checking for appointment text: ${error.message}`);
    // Assume appointments might be available if check fails, to be safe
    return false;
  }
}

// --- Main Check Logic ---

/**
 * The core routine to check for appointment availability.
 * Handles browser launch, navigation, captcha solving, and checking.
 * @param {AbortSignal} signal - The AbortSignal to allow cancellation.
 */
async function runCheck(signal) {
  console.log("🚀 Starting appointment check...");
  state.isRunning = true;

  try {
    // 1. Initialize Browser and Page
    console.log(" puppeteer launch...");
    state.browser = await puppeteer.launch({
      headless: "new", // Use "new" headless mode
      args: ["--no-sandbox", "--disable-dev-shm-usage"], // Common args for server environments
    });
    state.page = await state.browser.newPage();
    await state.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    ); // Set a common user agent
    await state.page.setViewport({ width: 1280, height: 800 }); // Set viewport

    // Handle abort signal for browser closing
    signal.addEventListener(
      "abort",
      async () => {
        console.log(
          "🚨 Abort signal received during browser operation. Closing browser."
        );
        await cleanupResources(); // Ensure cleanup on abort
      },
      { once: true }
    );

    // 2. Navigate to the URL
    console.log(`Navigating to ${APPOINTMENT_URL}...`);
    await state.page.goto(APPOINTMENT_URL, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_NAVIGATION_TIMEOUT_MS,
    });
    console.log("Navigation successful.");

    // Check if aborted after navigation
    if (signal.aborted) throw new Error("Check aborted after navigation.");

    // 3. Solve Captcha Loop
    while (true) {
      if (signal.aborted)
        throw new Error("Check aborted before getting captcha.");

      const captchaCode = await getCaptchaFromUser(signal); // Pass signal
      if (signal.aborted)
        throw new Error("Check aborted after getting captcha code.");

      console.log("Submitting captcha...");
      await state.page.type(CAPTCHA_INPUT_SELECTOR, captchaCode);
      await Promise.all([
        state.page.keyboard.press("Enter"),
        state.page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: PAGE_NAVIGATION_TIMEOUT_MS, // Use long timeout for navigation
        }),
      ]);
      console.log("Captcha submitted.");

      if (signal.aborted)
        throw new Error("Check aborted after submitting captcha.");

      // Check if captcha was wrong
      const isWrongCaptcha = await state.page.evaluate(
        (text) => document.body.innerText.includes(text),
        WRONG_CAPTCHA_TEXT
      );

      if (isWrongCaptcha) {
        await safeSendMessage("❌ Wrong captcha. Requesting a new one...");
        console.log("Wrong captcha detected.");
        // Click refresh - ensure selector exists first
        try {
          await state.page.waitForSelector(CAPTCHA_REFRESH_SELECTOR, {
            timeout: 5000,
            signal,
          });
          await state.page.click(CAPTCHA_REFRESH_SELECTOR);
          await state.page.waitForTimeout(1000); // Small delay for refresh
        } catch (e) {
          console.warn(
            "Captcha refresh button not found or timed out, attempting page reload."
          );
          await state.page.reload({ waitUntil: "domcontentloaded" }); // Reload if refresh fails
        }
        continue; // Loop back to get new captcha
      }

      console.log("✅ Captcha accepted.");
      break; // Exit loop if captcha is correct
    }

    // 4. Check for Appointments (Current Month)
    console.log("Checking current month for appointments...");
    const noAppointmentsThisMonth = await checkForNoAppointments();

    if (signal.aborted)
      throw new Error("Check aborted after checking current month.");

    if (noAppointmentsThisMonth) {
      console.log("No appointments found this month. Checking next month...");
      // 5. Check Next Month
      try {
        await state.page.waitForSelector(NEXT_MONTH_BUTTON_SELECTOR, {
          timeout: CAPTCHA_TIMEOUT_MS, // Use shorter timeout here
          signal,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Small delay
        await state.page.click(NEXT_MONTH_BUTTON_SELECTOR);
        await state.page.waitForNetworkIdle({
          timeout: CAPTCHA_TIMEOUT_MS,
          signal,
        }); // Wait for potential AJAX loads
        console.log("Clicked 'Next Month'.");

        if (signal.aborted)
          throw new Error("Check aborted after clicking next month.");

        const noAppointmentsNextMonth = await checkForNoAppointments();
        if (signal.aborted)
          throw new Error("Check aborted after checking next month.");

        if (noAppointmentsNextMonth) {
          console.log("No appointments found next month either.");
          await safeSendMessage(
            `→ No appointments found for this or next month (${new Date().toLocaleString()}). Retrying in 30 minutes.`
          );
        } else {
          console.log("‼️ Appointments found for NEXT month!");
          await notifyAvailable(
            `‼️ Appointment AVAILABLE (Next Month)! ‼️\n${APPOINTMENT_URL}`
          );
        }
      } catch (error) {
        if (error.name === "AbortError") {
          throw error; // Propagate abort
        }
        console.error(`Error trying to check next month: ${error.message}`);
        await safeSendMessage(
          `⚠️ Could not check next month (button might be missing or timed out). Assuming no appointments for now.`
        );
      }
    } else {
      // Appointments found in the current month
      console.log("‼️ Appointments found for CURRENT month!");
      await notifyAvailable(
        `‼️ Appointment AVAILABLE NOW! ‼️\n${APPOINTMENT_URL}`
      );
    }

    console.log("✅ Check completed successfully.");
  } catch (error) {
    if (error.message.includes("aborted")) {
      console.log(`🏃 Check was aborted: ${error.message}`);
      // No message to user needed if aborted intentionally
    } else {
      console.error(`❌ Error during appointment check: ${error.message}`);
      console.error(error.stack); // Log stack trace for debugging
      await safeSendMessage(
        `❌ Bot error during check: ${error.message}. Please check logs.`
      );
    }
  } finally {
    // 6. Cleanup
    await cleanupResources();
  }
}

// --- Bot Command Handlers ---

/**
 * Initiates a check process, handling potential existing runs.
 */
async function startCheckProcess() {
  if (state.isRunning) {
    console.log("🚫 Check already in progress. Ignoring request.");
    await safeSendMessage("⏳ A check is already running. Please wait.");
    return;
  }

  // Create a new AbortController for this check
  state.currentAbortController = new AbortController();
  // Run the check, passing the signal
  runCheck(state.currentAbortController.signal);
}

// Handler for /checknow command
bot.onText(/\/checknow/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  await safeSendMessage("🔍 Starting the check now. Please wait...");
  console.log("Received /checknow command.");

  if (state.isRunning) {
    console.log("⚠️ Check is running. Aborting previous check...");
    await safeSendMessage(
      "⏳ Previous check is running. Attempting to cancel it first..."
    );
    if (state.currentAbortController) {
      state.currentAbortController.abort(); // Signal the current check to abort
    }
    // Give cleanup a moment before starting new check
    // Note: A more robust way might involve waiting for a promise from cleanupResources
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("Previous check should be aborted. Starting new check.");
  }

  // Ensure state is reset before starting (in case cleanup didn't fully run)
  state.isRunning = false;
  state.isWaitingForCaptcha = false;
  if (state.spamInterval) clearInterval(state.spamInterval);
  state.spamInterval = null;
  if (state.captchaMessageListener)
    bot.removeListener("message", state.captchaMessageListener);
  state.captchaMessageListener = null;

  startCheckProcess(); // Start a new check
});

// Handler for /another command (reload captcha)
bot.onText(/\/another/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  if (!state.isRunning || !state.isWaitingForCaptcha || !state.page) {
    await safeSendMessage(
      "❓ Cannot get another captcha right now (no check running or not waiting for captcha)."
    );
    return;
  }

  console.log("Received /another command.");
  await safeSendMessage("🔄 Requesting a new captcha...");

  try {
    // Option 1: Try clicking the refresh button if available
    let refreshed = false;
    try {
      await state.page.waitForSelector(CAPTCHA_REFRESH_SELECTOR, {
        visible: true,
        timeout: 3000,
      });
      await state.page.click(CAPTCHA_REFRESH_SELECTOR);
      await state.page.waitForTimeout(1000); // Wait a bit for refresh
      console.log("Clicked captcha refresh button.");
      refreshed = true;
    } catch (e) {
      console.log(
        "Captcha refresh button not found or failed, trying page reload."
      );
    }

    // Option 2: Reload the page if refresh button fails or doesn't exist
    if (!refreshed) {
      await state.page.reload({ waitUntil: "domcontentloaded" });
      console.log("Reloaded page for new captcha.");
    }

    // Abort the previous getCaptchaFromUser promise (if it's still waiting)
    // This is tricky because the promise is internal to getCaptchaFromUser.
    // A simpler approach is to just let the old listener time out or be removed
    // when the *new* getCaptchaFromUser is called.

    // Re-request captcha from user (this will send the new image)
    // NOTE: This assumes runCheck's loop will call getCaptchaFromUser again.
    // If /another is called *outside* the captcha loop, this won't work directly.
    // The current structure relies on the user *replying* to the message sent by getCaptchaFromUser.
    // A direct call here might disrupt the flow.
    // Let's just signal the user we tried and let the main loop handle re-fetching.
    await safeSendMessage(
      "✅ Attempted to refresh. Please wait for the new captcha image (if the bot asks again)."
    );
    // It might be better to abort the current *captcha wait* specifically and have the main loop retry.
    // However, the current structure relies on the user reply. Let's stick to refresh/reload for now.
  } catch (error) {
    console.error(`Error handling /another: ${error.message}`);
    await safeSendMessage(`⚠️ Error refreshing captcha: ${error.message}`);
  }
});

// --- Cron Job Scheduling ---
console.log(`Scheduling check with cron schedule: "${CRON_SCHEDULE}"`);
cron.schedule(CRON_SCHEDULE, () => {
  console.log("⏰ Cron job triggered.");
  if (state.isRunning) {
    console.log("🚫 Cron: Check already running. Skipping.");
    return;
  }
  if (state.isWaitingForCaptcha) {
    console.log("🚫 Cron: Waiting for captcha input. Skipping check.");
    // Optionally, send a reminder?
    // safeSendMessage("⏰ Reminder: Still waiting for captcha input.");
    return;
  }
  startCheckProcess(); // Start check if not running and not waiting
});

// --- Initial Run and Startup Message ---
(async () => {
  await safeSendMessage(
    `👋 Bot started. Initial check starting now...\n\nAvailable commands:\n/checknow - Run check immediately\n/another - Try to get a new captcha image\nOK - Stop appointment alerts`
  );
  startCheckProcess(); // Start the first check immediately
})();

console.log("🤖 Telegram bot polling started...");

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  if (state.currentAbortController) {
    state.currentAbortController.abort();
  }
  await cleanupResources();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  if (state.currentAbortController) {
    state.currentAbortController.abort();
  }
  await cleanupResources();
  process.exit(0);
});
