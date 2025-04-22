import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import puppeteer from "puppeteer";
import { Buffer } from "node:buffer"; // Explicit import for Buffer
import axios from "axios"; // Import axios for API calls
import nodemailer from "nodemailer"; // Import nodemailer for email

// --- Constants ---
const CAPTCHA_TIMEOUT_MS = 60 * 1000; // Increased timeout for anti-captcha service (also used for manual captcha wait)
const PAGE_NAVIGATION_TIMEOUT_MS = 29 * 60 * 1000; // 29 minutes
const NOTIFICATION_INTERVAL_MS = 5 * 1000; // 5 seconds (for repeated notifications)
const MAX_NOTIFICATIONS = 50; // Maximum number of repeated notifications (Telegram, Email, Pushbullet combined in interval)
const EMAIL_NOTIFICATION_FREQUENCY = 10; // Send email every X notifications
const MAX_EMAIL_NOTIFICATIONS = 10; // Maximum number of emails to send during repeated notifications
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

// Anti-Captcha Constants
const ANTICAPTCHA_API_BASE_URL = "https://api.anti-captcha.com";
const ANTICAPTCHA_TASK_TYPE = "ImageToTextTask"; // Type for image captchas
const ANTICAPTCHA_POLLING_INTERVAL_MS = 5000; // Poll every 5 seconds

// Pushbullet Constants
const PUSHBULLET_API_BASE_URL = "https://api.pushbullet.com/v2";

// --- Environment Variable Validation ---
const {
  BOT_TOKEN,
  CHAT_ID,
  ANTI_CAPTCHA_API_KEY,
  EMAIL_SENDER,
  EMAIL_PASSWORD, // Use an App Password if using Gmail
  EMAIL_RECIPIENT,
  PUSHBULLET_API_KEY,
} = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error(
    "Error: BOT_TOKEN and CHAT_ID environment variables are required."
  );
  process.exit(1); // Exit if essential variables are missing
}

// Check for anti-captcha key and notification variables, but allow running without them
const enableAntiCaptcha = !!ANTI_CAPTCHA_API_KEY;
const enableEmail = EMAIL_SENDER && EMAIL_PASSWORD && EMAIL_RECIPIENT;
const enablePushbullet = PUSHBULLET_API_KEY;

if (!enableAntiCaptcha) {
  console.warn(
    "Warning: Running without ANTI_CAPTCHA_API_KEY. Manual captcha input will be required."
  );
}
if (!enableEmail) {
  console.warn(
    "Warning: Email notifications are not fully configured (EMAIL_SENDER, EMAIL_PASSWORD, and EMAIL_RECIPIENT are required)."
  );
}
if (!enablePushbullet) {
  console.warn(
    "Warning: Pushbullet notifications are not configured (PUSHBULLET_API_KEY is required)."
  );
}

// --- Bot Initialization ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- Nodemailer Transporter (for email) ---
let transporter = null;
if (enableEmail) {
  transporter = nodemailer.createTransport({
    service: "gmail", // Or your email service
    auth: {
      user: EMAIL_SENDER,
      pass: EMAIL_PASSWORD, // Use App Password for Gmail
    },
  });
}

// --- State Management ---
let state = {
  isRunning: false, // Is a check currently running?
  isWaitingForCaptcha: false, // Is the bot waiting for user's captcha input? (for manual mode)
  captchaMessageListener: null, // Reference to the active message listener for captcha (for manual mode)
  spamInterval: null, // Interval ID for "appointment available" notifications
  browser: null, // Puppeteer browser instance
  page: null, // Puppeteer page instance
  currentAbortController: null, // AbortController for the current check
  // Promise resolver for notifyAvailable, allows runCheck to wait
  notifyAvailableResolver: null,
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
 * Sends an email notification.
 * @param {string} subject - The email subject.
 * @param {string} text - The email body.
 */
async function sendEmailNotification(subject, text) {
  if (!enableEmail || !transporter) {
    console.log(
      "Email notifications are not enabled or transporter not initialized."
    );
    return;
  }
  console.log(`📧 Sending email: "${subject}"`);
  try {
    await transporter.sendMail({
      from: EMAIL_SENDER,
      to: EMAIL_RECIPIENT,
      subject: subject,
      text: text,
    });
    console.log("Email sent successfully.");
  } catch (error) {
    console.error(`❌ Failed to send email: ${error.message}`);
  }
}

/**
 * Sends a Pushbullet notification.
 * @param {string} title - The notification title.
 * @param {string} body - The notification body.
 */
async function sendPushNotification(title, body) {
  if (!enablePushbullet) {
    console.log("Pushbullet notifications are not enabled.");
    return;
  }
  console.log(`📱 Sending Pushbullet notification: "${title}"`);
  try {
    await axios.post(
      `${PUSHBULLET_API_BASE_URL}/pushes`,
      {
        type: "note",
        title: title,
        body: body,
      },
      {
        headers: {
          "Access-Token": PUSHBULLET_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 10000, // Add a timeout for the API call
      }
    );
    console.log("Pushbullet notification sent successfully.");
  } catch (error) {
    console.error(
      `❌ Failed to send Pushbullet notification: ${error.message}`
    );
    if (error.response) {
      console.error(
        `Pushbullet API responded with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`
      );
    } else if (error.request) {
      console.error("No response received from Pushbullet API.");
    }
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
  state.isWaitingForCaptcha = false; // Reset manual captcha flag
  state.isRunning = false; // Mark as not running AFTER cleanup
  state.currentAbortController = null;
  // Resolve the notifyAvailable promise if it exists
  if (state.notifyAvailableResolver) {
    state.notifyAvailableResolver();
    state.notifyAvailableResolver = null;
  }
  console.log("🧼 Cleanup complete.");
}

/**
 * Extracts captcha image, sends it via Telegram, and waits for user reply.
 * Handles potential timeouts and abort signals. (For manual mode)
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
      console.error(`Error during manual captcha process: ${error.message}`);
    }
    throw error; // Re-throw the error to be caught by runCheck
  }
}

/**
 * Submits an image captcha to Anti-Captcha.com and polls for the result.
 * @param {string} base64Image - The base64 encoded image data (without 'data:image/png;base64,' prefix).
 * @param {AbortSignal} signal - The AbortSignal to allow cancellation.
 * @returns {Promise<string>} Resolves with the solved captcha text.
 * @throws {Error} If the API call fails, task creation fails, polling times out, or operation is aborted.
 */
async function solveCaptcha(base64Image, signal) {
  if (!enableAntiCaptcha) {
    // This function should only be called if anti-captcha is enabled,
    // but adding a check here for safety.
    throw new Error("Anti-captcha is not enabled.");
  }
  console.log("🤖 Submitting captcha to Anti-Captcha.com...");
  let taskId = null;

  try {
    // 1. Create Task
    const createTaskResponse = await axios.post(
      `${ANTICAPTCHA_API_BASE_URL}/createTask`,
      {
        clientKey: ANTI_CAPTCHA_API_KEY,
        task: {
          type: ANTICAPTCHA_TASK_TYPE,
          body: base64Image,
        },
        // Optional: Add websiteUrl if needed by the service for context
        // websiteUrl: APPOINTMENT_URL,
      },
      { signal, timeout: CAPTCHA_TIMEOUT_MS }
    ); // Add timeout for the API call

    if (createTaskResponse.data.errorId !== 0) {
      throw new Error(
        `Anti-Captcha API error creating task: ${createTaskResponse.data.errorDescription}`
      );
    }
    taskId = createTaskResponse.data.taskId;
    console.log(`Task created with ID: ${taskId}. Polling for result...`);

    // 2. Poll for Result
    const startTime = Date.now();
    while (Date.now() - startTime < CAPTCHA_TIMEOUT_MS) {
      if (signal.aborted) {
        // Attempt to cancel the task if aborted while polling
        if (taskId) {
          try {
            await axios.post(
              `${ANTICAPTCHA_API_BASE_URL}/getTaskResult`,
              {
                clientKey: ANTI_CAPTCHA_API_KEY,
                taskId: taskId,
              },
              { signal: AbortSignal.timeout(5000) }
            ); // Short timeout for cancel attempt
            console.log(`Attempted to cancel task ${taskId} on abort.`);
          } catch (cancelError) {
            console.warn(
              `Failed to send cancel request for task ${taskId}: ${cancelError.message}`
            );
          }
        }
        throw new Error("Captcha solving aborted.");
      }

      await new Promise((resolve) =>
        setTimeout(resolve, ANTICAPTCHA_POLLING_INTERVAL_MS)
      ); // Wait before polling

      const getResultResponse = await axios.post(
        `${ANTICAPTCHA_API_BASE_URL}/getTaskResult`,
        {
          clientKey: ANTI_CAPTCHA_API_KEY,
          taskId: taskId,
        },
        { signal, timeout: CAPTCHA_TIMEOUT_MS }
      ); // Add timeout for the API call

      if (getResultResponse.data.errorId !== 0) {
        // Check if the error is related to task not being ready yet
        if (getResultResponse.data.errorCode === "TASK_NOT_READY") {
          console.log(`Task ${taskId} not ready yet. Polling again...`);
          continue; // Continue polling
        }
        throw new Error(
          `Anti-Captcha API error getting result for task ${taskId}: ${getResultResponse.data.errorDescription}`
        );
      }

      if (getResultResponse.data.status === "processing") {
        console.log(`Task ${taskId} still processing...`);
        continue; // Continue polling
      }

      if (getResultResponse.data.status === "ready") {
        console.log(
          `✅ Captcha solved: ${getResultResponse.data.solution.text}`
        );
        return getResultResponse.data.solution.text; // Return the solved text
      }

      // Handle unexpected status
      throw new Error(
        `Anti-Captcha API returned unexpected status for task ${taskId}: ${getResultResponse.data.status}`
      );
    }

    // If loop finishes without result
    throw new Error(
      `Captcha solving timed out after ${
        CAPTCHA_TIMEOUT_MS / 1000
      } seconds for task ${taskId}.`
    );
  } catch (error) {
    console.error(
      `❌ Error during Anti-Captcha solving process: ${error.message}`
    );
    if (error.name === "AbortError") {
      console.log("Anti-Captcha solving explicitly aborted.");
    } else if (axios.isCancel(error)) {
      console.log("Anti-Captcha API request was cancelled.");
    } else if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error(
        `Anti-Captcha API responded with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`
      );
    } else if (error.request) {
      // The request was made but no response was received
      console.error("No response received from Anti-Captcha API.");
    }
    throw error; // Re-throw the error
  }
}

/**
 * Notifies the user repeatedly via Telegram, Email, and Pushbullet until they acknowledge with "OK" or max notifications reached.
 * Returns a Promise that resolves when notifications stop.
 * @param {string} message - The notification message.
 * @returns {Promise<void>} A promise that resolves when notifications are stopped.
 */
async function notifyAvailable(message) {
  if (state.spamInterval) {
    console.log("Notifications already active.");
    return Promise.resolve(); // Already notifying, return immediately
  }

  return new Promise((resolve) => {
    state.notifyAvailableResolver = resolve; // Store the resolver

    let notificationCount = 0;
    let emailCount = 0;

    // Function to send all types of notifications
    const sendAllNotifications = async () => {
      console.log(
        `Sending notification ${
          notificationCount + 1
        } of ${MAX_NOTIFICATIONS}...`
      );
      await safeSendMessage(message);
      await sendPushNotification(
        "Appointment Available!",
        "Check Telegram for details: " + message
      );

      // Send email only on every EMAIL_NOTIFICATION_FREQUENCY notification, up to MAX_EMAIL_NOTIFICATIONS
      if (
        (notificationCount + 1) % EMAIL_NOTIFICATION_FREQUENCY === 0 &&
        emailCount < MAX_EMAIL_NOTIFICATIONS
      ) {
        await sendEmailNotification(
          `Appointment Available (Alert ${emailCount + 1})!`,
          message
        );
        emailCount++;
      }

      notificationCount++;

      // Stop interval if max notifications reached
      if (notificationCount >= MAX_NOTIFICATIONS) {
        console.log(
          `Max notifications (${MAX_NOTIFICATIONS}) reached. Stopping alerts.`
        );
        stopNotifications();
      }
    };

    // Function to stop notifications and resolve the promise
    const stopNotifications = () => {
      if (state.spamInterval) {
        clearInterval(state.spamInterval);
        state.spamInterval = null;
      }
      bot.removeListener("message", stopHandler);
      if (state.notifyAvailableResolver) {
        state.notifyAvailableResolver();
        state.notifyAvailableResolver = null;
      }
    };

    // Send the first notification immediately
    sendAllNotifications();

    // Start repeated notifications
    state.spamInterval = setInterval(
      sendAllNotifications, // Use the combined notification function
      NOTIFICATION_INTERVAL_MS
    );

    // Listener to stop notifications
    const stopHandler = (msg) => {
      if (String(msg.chat.id) === CHAT_ID && msg.text?.toUpperCase() === "OK") {
        safeSendMessage("🆗 Got it - stopping alerts.");
        console.log("Notifications stopped by user.");
        stopNotifications(); // Stop notifications when user sends OK
      }
    };
    // Add the listener only once
    bot.on("message", stopHandler);
  });
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

      // Wait for captcha element
      await state.page.waitForSelector(CAPTCHA_SELECTOR, {
        timeout: CAPTCHA_TIMEOUT_MS,
        signal, // Pass signal here
      });

      // Extract base64 image data
      const base64 = await state.page.$eval(CAPTCHA_SELECTOR, (el) => {
        const bg = el.style.background;
        const match = bg.match(/base64,([^"]+)/);
        // Return only the base64 part, without the prefix
        return match ? match[1] : null;
      });

      if (!base64) {
        throw new Error("Could not extract base64 data from captcha element.");
      }

      // Solve the captcha using the anti-captcha service OR wait for manual input
      let solvedText = null;
      if (enableAntiCaptcha) {
        try {
          solvedText = await solveCaptcha(base64, signal);
        } catch (captchaError) {
          // If captcha solving fails, try refreshing and loop again
          console.error(
            `Captcha solving failed: ${captchaError.message}. Attempting refresh.`
          );
          await safeSendMessage(
            `⚠️ Captcha solving failed: ${captchaError.message}. Trying again with a new captcha.`
          );
          // Click refresh - ensure selector exists first
          try {
            await state.page.waitForSelector(CAPTCHA_REFRESH_SELECTOR, {
              timeout: 5000,
              signal,
            });
            await state.page.click(CAPTCHA_REFRESH_SELECTOR);
            await state.page.waitForTimeout(2000); // Small delay for refresh
          } catch (e) {
            console.warn(
              "Captcha refresh button not found or timed out, attempting page reload."
            );
            await state.page.reload({ waitUntil: "domcontentloaded" }); // Reload if refresh fails
          }
          continue; // Loop back to get and solve new captcha
        }
      } else {
        // Manual captcha solving
        try {
          solvedText = await getCaptchaFromUser(signal); // Wait for user input
        } catch (captchaError) {
          console.error(
            `Manual captcha input failed: ${captchaError.message}.`
          );
          // If manual input fails (e.g., timeout or abort), just re-loop to ask again
          await safeSendMessage(
            `⚠️ Failed to get manual captcha input: ${captchaError.message}. Please try again.`
          );
          // Attempt to reload page to get a new captcha for manual input
          try {
            await state.page.reload({ waitUntil: "domcontentloaded" });
            console.log("Reloaded page for new manual captcha.");
          } catch (reloadError) {
            console.error(
              `Error reloading page after manual captcha failure: ${reloadError.message}`
            );
          }
          continue; // Loop back to ask for captcha again
        }
      }

      if (signal.aborted)
        throw new Error("Check aborted after solving captcha.");

      console.log(`Submitting captcha: ${solvedText}`);
      await state.page.type(CAPTCHA_INPUT_SELECTOR, solvedText);
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
        await safeSendMessage(
          `❌ Submitted captcha "${solvedText}" was wrong. Requesting a new one...`
        );
        console.log("Wrong captcha detected after submission.");
        // Click refresh - ensure selector exists first
        try {
          await state.page.waitForSelector(CAPTCHA_REFRESH_SELECTOR, {
            timeout: 5000,
            signal,
          });
          await state.page.click(CAPTCHA_REFRESH_SELECTOR);
          await state.page.waitForTimeout(2000); // Small delay for refresh
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

    if (false && noAppointmentsThisMonth) {
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
          const message = `‼️ Appointment AVAILABLE (Next Month)! ‼️\n${APPOINTMENT_URL}`;
          // Await the notification process to complete
          await notifyAvailable(message);
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
      const message = `‼️ Appointment AVAILABLE NOW! ‼️\n${APPOINTMENT_URL}`;
      // Await the notification process to complete
      await notifyAvailable(message);
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
  state.isWaitingForCaptcha = false; // Reset manual captcha flag
  if (state.spamInterval) clearInterval(state.spamInterval);
  state.spamInterval = null;
  if (state.captchaMessageListener)
    // Clean up manual captcha listener if active
    bot.removeListener("message", state.captchaMessageListener);
  state.captchaMessageListener = null;
  // Ensure the notifyAvailable promise is resolved if a new check starts
  if (state.notifyAvailableResolver) {
    state.notifyAvailableResolver();
    state.notifyAvailableResolver = null;
  }

  startCheckProcess(); // Start a new check
});

// Handler for /another command (reload captcha)
bot.onText(/\/another/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  if (!state.isRunning || !state.page) {
    await safeSendMessage(
      "❓ Cannot get another captcha right now (no check running)."
    );
    return;
  }

  console.log("Received /another command.");
  await safeSendMessage(
    "🔄 Attempting to refresh the page to get a new captcha..."
  );

  try {
    // Abort the current check's captcha solving process if it's stuck
    if (state.currentAbortController) {
      // Abort the current captcha solving/waiting process
      state.currentAbortController.abort();
      // Create a new controller for the subsequent steps
      state.currentAbortController = new AbortController();
    }

    // Reload the page to force a new captcha
    await state.page.reload({ waitUntil: "domcontentloaded" });
    console.log("Reloaded page for new captcha.");

    // Inform the user what to expect next based on mode
    if (enableAntiCaptcha) {
      await safeSendMessage(
        "✅ Page reloaded. The bot will attempt to solve the new captcha automatically."
      );
    } else {
      await safeSendMessage(
        "✅ Page reloaded. Please wait for the new captcha image to appear here so you can solve it manually."
      );
    }
  } catch (error) {
    console.error(`Error handling /another: ${error.message}`);
    await safeSendMessage(
      `⚠️ Error reloading page for new captcha: ${error.message}`
    );
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
  if (!enableAntiCaptcha && state.isWaitingForCaptcha) {
    console.log("🚫 Cron: Waiting for manual captcha input. Skipping check.");
    // Optionally, send a reminder?
    // safeSendMessage("⏰ Reminder: Still waiting for captcha input.");
    return;
  }
  startCheckProcess(); // Start check if not running and not waiting for manual captcha
});

// --- Initial Run and Startup Message ---
(async () => {
  let startupMessage = `👋 Bot started. Initial check starting now...\n\nAvailable commands:\n/checknow - Run check immediately\n/another - Reload page to get a new captcha\nOK - Stop appointment alerts`;

  if (enableAntiCaptcha) {
    startupMessage += `\n🤖 Automated captcha solving is enabled.`;
  } else {
    startupMessage += `\n✍️ Manual captcha solving is required.`;
  }

  if (enableEmail) {
    startupMessage += `\n📧 Email notifications are enabled.`;
  } else {
    startupMessage += `\n⚠️ Email notifications are NOT enabled (check .env).`;
  }

  if (enablePushbullet) {
    startupMessage += `\n📱 Pushbullet notifications are enabled.`;
  } else {
    startupMessage += `\n⚠️ Pushbullet notifications are NOT enabled (check .env).`;
  }

  await safeSendMessage(startupMessage);
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
