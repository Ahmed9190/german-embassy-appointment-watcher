import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import puppeteer from "puppeteer";
import { Buffer } from "node:buffer"; // Explicit import for Buffer
import axios from "axios"; // Import axios for API calls
import nodemailer from "nodemailer"; // Import nodemailer for email
import moment from "moment-timezone"; // Import moment-timezone

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
const CAPTCHA_REFRESH_SELECTOR = "#appointment_captcha_month_refreshcaptcha"; // Still needed for error handling fallback
const NEXT_MONTH_BUTTON_SELECTOR =
  "#content > div.wrapper > h2:nth-child(3) > a:nth-child(2)";
const NO_APPOINTMENTS_TEXT = "Unfortunately, there are no appointments";
const WRONG_CAPTCHA_TEXT = "The entered text was wrong";

// Default Working Time Window (Local Time) - Used if not set by commands
// Working from 10:00 AM to 1:00 AM
const DEFAULT_WORKING_START_HOUR = 10; // 10 AM
const DEFAULT_WORKING_START_MINUTE = 0; // 00 minutes
const DEFAULT_WORKING_END_HOUR = 1; // 1 AM
const DEFAULT_WORKING_END_MINUTE = 0; // 00 minutes

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
  TIMEZONE, // New TIMEZONE environment variable
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
const enableTimezoneRestriction = !!TIMEZONE;

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
if (!enableTimezoneRestriction) {
  console.warn(
    "Warning: TIMEZONE environment variable is not set. Time restriction will use server's local time."
  );
} else {
  // Validate timezone string
  if (!moment.tz.zone(TIMEZONE)) {
    console.error(
      `Error: Invalid TIMEZONE specified: ${TIMEZONE}. Please use a valid IANA timezone name (e.g., 'Europe/Berlin').`
    );
    process.exit(1); // Exit if timezone is invalid
  }
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

// --- Console to Telegram Logging ---
// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Override console methods
console.log = (...args) => {
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");
  originalConsoleLog(...args); // Log to console
  // Send to Telegram ONLY if logging is enabled and not during sensitive operations
  if (
    state.isLoggingEnabled &&
    !state.isWaitingForCaptcha &&
    !state.spamInterval
  ) {
    const telegramMessage = `[LOG] ${message}`.substring(0, 4000); // Limit message length
    safeSendMessage(telegramMessage);
  }
};

console.warn = (...args) => {
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");
  originalConsoleWarn(...args); // Log to console
  const telegramMessage = `[WARN] ${message}`.substring(0, 4000); // Limit message length
  safeSendMessage(telegramMessage); // Always send warnings
};

console.error = (...args) => {
  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");
  originalConsoleError(...args); // Log to console
  const telegramMessage = `[ERROR] ${message}`.substring(0, 4000); // Limit message length
  safeSendMessage(telegramMessage); // Always send errors
};

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
  // Dynamic working time
  workingStartHour: DEFAULT_WORKING_START_HOUR,
  workingStartMinute: DEFAULT_WORKING_START_MINUTE,
  workingEndHour: DEFAULT_WORKING_END_HOUR,
  workingEndMinute: DEFAULT_WORKING_END_MINUTE,
  isLoggingEnabled: false,
};

// --- Helper Functions ---

/**
 * Checks if the current time in the specified timezone is within the working period.
 * Uses the TIMEZONE environment variable if set, otherwise uses local time.
 * Uses dynamic working hours/minutes if set by commands, otherwise uses defaults.
 * @returns {boolean} True if within working hours, false otherwise.
 */
function isWithinWorkingHours() {
  const now = enableTimezoneRestriction ? moment().tz(TIMEZONE) : moment(); // Use moment with timezone if enabled

  const startMoment = enableTimezoneRestriction
    ? moment.tz(
        { hour: state.workingStartHour, minute: state.workingStartMinute },
        TIMEZONE
      )
    : moment({
        hour: state.workingStartHour,
        minute: state.workingStartMinute,
      });

  const endMoment = enableTimezoneRestriction
    ? moment.tz(
        { hour: state.workingEndHour, minute: state.workingEndMinute },
        TIMEZONE
      )
    : moment({ hour: state.workingEndHour, minute: state.workingEndMinute });

  // Handle cases where the working period spans across midnight
  if (startMoment.isAfter(endMoment)) {
    // Working hours are from startMoment to endMoment (next day)
    return now.isSameOrAfter(startMoment) || now.isBefore(endMoment);
  } else {
    // Working hours are from startMoment to endMoment (same day)
    return now.isSameOrAfter(startMoment) && now.isBefore(endMoment);
  }
}

/**
 * Gets the current time string, including timezone information if enabled.
 * @returns {string} The formatted current time string.
 */
function getCurrentTimeString() {
  const now = enableTimezoneRestriction ? moment().tz(TIMEZONE) : moment();
  return enableTimezoneRestriction
    ? `${now.format("YYYY-MM-DD HH:mm:ss")} ${now.tz()}`
    : now.format("YYYY-MM-DD HH:mm:ss [Local]");
}

/**
 * Sends a message safely, catching potential Telegram API errors.
 * @param {string} text - The message text.
 */
async function safeSendMessage(text) {
  try {
    // Ensure text is a string and not empty before sending
    if (typeof text !== "string" || text.trim() === "") {
      originalConsoleWarn(
        "Attempted to send empty or non-string message to Telegram."
      );
      return;
    }
    await bot.sendMessage(CHAT_ID, text);
  } catch (error) {
    // Log the error to the original console to avoid infinite loops
    originalConsoleError(
      `Failed to send message to Telegram: ${error.message}`
    );
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
    // Log the error to the original console to avoid infinite loops
    originalConsoleError(`Failed to send photo to Telegram: ${error.message}`);
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
      caption: "🖼️ New captcha. Reply with the text.", // Removed /another from caption
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
      console.log("Repeated notifications stopped.");
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
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // Add necessary arguments
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
    let captchaAttempts = 0;
    const MAX_CAPTCHA_ATTEMPTS = 5; // Limit attempts to avoid infinite loops

    while (captchaAttempts < MAX_CAPTCHA_ATTEMPTS) {
      if (signal.aborted)
        throw new Error("Check aborted before getting captcha.");

      // Wait for captcha element (this will wait for the initial or a new captcha after wrong input)
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
          // If anti-captcha solving fails, log and retry the loop (which will get the same captcha)
          console.error(
            `Captcha solving failed: ${captchaError.message}. Retrying...`
          );
          await safeSendMessage(
            `⚠️ Captcha solving failed: ${captchaError.message}. Retrying with the same captcha.`
          );
          captchaAttempts++; // Increment attempt counter on failure
          continue; // Loop back to try solving the same captcha again
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
          // Attempt to reload page to get a new captcha for manual input as a fallback
          try {
            await state.page.reload({ waitUntil: "domcontentloaded" });
            console.log("Reloaded page for new manual captcha.");
          } catch (reloadError) {
            console.error(
              `Error reloading page after manual captcha failure: ${reloadError.message}`
            );
          }
          captchaAttempts++; // Increment attempt counter on failure
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
        console.log(
          `❌ Submitted captcha "${solvedText}" was wrong. The website should show a new one.`
        );
        await safeSendMessage(
          `❌ Submitted captcha "${solvedText}" was wrong. The website should have loaded a new captcha. Attempting to solve the new one.`
        );
        captchaAttempts++; // Increment attempt counter on wrong captcha
        // The loop will continue, wait for the new CAPTCHA_SELECTOR, and try again
        continue;
      }

      console.log("✅ Captcha accepted.");
      break; // Exit loop if captcha is correct
    }

    // Check if we exited the loop due to max attempts
    if (captchaAttempts >= MAX_CAPTCHA_ATTEMPTS) {
      throw new Error(
        `Failed to solve captcha after ${MAX_CAPTCHA_ATTEMPTS} attempts.`
      );
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
          waitUntil: "domcontentloaded", // Wait for DOM content
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
            `→ No appointments found for this or next month (${getCurrentTimeString()}). Retrying in 30 minutes.`
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
 * @param {boolean} [bypassTimeCheck=false] - Whether to bypass the working time check.
 */
async function startCheckProcess(bypassTimeCheck = false) {
  if (state.isRunning) {
    console.log("🚫 Check already in progress. Ignoring request.");
    await safeSendMessage("⏳ A check is already running. Please wait.");
    return;
  }

  // Check if within working hours before starting, unless bypassing
  // The cron job and non-bypassing calls should only run *within* working hours.
  if (!bypassTimeCheck && !isWithinWorkingHours()) {
    const currentTime = getCurrentTimeString();
    const workingPeriod = `${String(state.workingStartHour).padStart(
      2,
      "0"
    )}:${String(state.workingStartMinute).padStart(2, "0")} to ${String(
      state.workingEndHour
    ).padStart(2, "0")}:${String(state.workingEndMinute).padStart(2, "0")}`;
    console.log(
      `🚫 Cannot start scheduled check. Currently outside working hours (${workingPeriod} ${
        enableTimezoneRestriction ? TIMEZONE : "local time"
      }). Current time: ${currentTime}`
    );
    // Only send a message if logging is enabled to avoid spam during off-hours
    if (state.isLoggingEnabled) {
      // Optional: send a message indicating cron was skipped due to working hours
      // await safeSendMessage(`⏰ Cron check skipped. Currently outside working hours (${workingPeriod}).`);
    }
    return;
  }

  // Create a new AbortController for this check
  state.currentAbortController = new AbortController();
  // Run the check, passing the signal
  runCheck(state.currentAbortController.signal);
}

// Handler for /checknow command (bypasses working time restriction)
bot.onText(/\/checknow/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  console.log("Received /checknow command.");

  // Check if a check is already running and abort if necessary
  if (state.isRunning) {
    console.log("⚠️ Check is running. Aborting previous check...");
    await safeSendMessage(
      "⏳ Previous check is running. Attempting to cancel it first..."
    );
    if (state.currentAbortController) {
      state.currentAbortController.abort(); // Signal the current check to abort
    }
    // Give cleanup a moment before starting new check
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

  await safeSendMessage(
    "🚀 Starting a manual check now (bypassing working hour restriction). Please wait..."
  );
  startCheckProcess(true); // Start check, bypassing working hour restriction
});

// Handler for /startat command
bot.onText(/\/startat (\d{1,2}):(\d{2})/, async (msg, match) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await safeSendMessage(
      "❌ Invalid time format. Please use HH:MM (24-hour format)."
    );
    return;
  }

  state.workingStartHour = hour;
  state.workingStartMinute = minute;

  const workingPeriod = `${String(state.workingStartHour).padStart(
    2,
    "0"
  )}:${String(state.workingStartMinute).padStart(2, "0")} to ${String(
    state.workingEndHour
  ).padStart(2, "0")}:${String(state.workingEndMinute).padStart(2, "0")}`;
  await safeSendMessage(
    `✅ Working hour start time set to ${String(hour).padStart(
      2,
      "0"
    )}:${String(minute).padStart(2, "0")} ${
      enableTimezoneRestriction ? TIMEZONE : "local time"
    }. Current working period: ${workingPeriod}`
  );
  console.log(`Working hour start time set to ${hour}:${minute}`);
});

// Handler for /stopat command
bot.onText(/\/stopat (\d{1,2}):(\d{2})/, async (msg, match) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await safeSendMessage(
      "❌ Invalid time format. Please use HH:MM (24-hour format)."
    );
    return;
  }

  state.workingEndHour = hour;
  state.workingEndMinute = minute;

  const workingPeriod = `${String(state.workingStartHour).padStart(
    2,
    "0"
  )}:${String(state.workingStartMinute).padStart(2, "0")} to ${String(
    state.workingEndHour
  ).padStart(2, "0")}:${String(state.workingEndMinute).padStart(2, "0")}`;
  await safeSendMessage(
    `✅ Working hour end time set to ${String(hour).padStart(2, "0")}:${String(
      minute
    ).padStart(2, "0")} ${
      enableTimezoneRestriction ? TIMEZONE : "local time"
    }. Current working period: ${workingPeriod}`
  );
  console.log(`Working hour end time set to ${hour}:${minute}`);
});

// Handler for /toggle_log command
bot.onText(/\/toggle_log/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  state.isLoggingEnabled = !state.isLoggingEnabled;
  const status = state.isLoggingEnabled ? "ENABLED" : "DISABLED";
  await safeSendMessage(
    `✅ Logging to Telegram is now ${status}. (Warnings and Errors are always sent).`
  );
  console.log(`Logging to Telegram toggled to ${status}`);
});

// Handler for /shutdown command to completely stop the bot
bot.onText(/\/shutdown/, async (msg) => {
  if (String(msg.chat.id) !== CHAT_ID) return;

  console.log("Received /shutdown command. Shutting down...");
  await safeSendMessage(
    "🛑 Shutting down bot. All checks and notifications will stop."
  );

  // Perform cleanup
  await cleanupResources();

  // Stop polling for new messages
  bot.stopPolling();

  // Exit the Node.js process
  process.exit(0);
});

// --- Cron Job Scheduling ---
console.log(
  `Scheduling check with cron schedule: "${CRON_SCHEDULE}". Checks restricted dynamically.`
);
cron.schedule(CRON_SCHEDULE, () => {
  console.log("⏰ Cron job triggered.");

  // Check if within working hours before starting
  // Cron should only run *within* the defined working hours.
  if (!isWithinWorkingHours()) {
    const currentTime = getCurrentTimeString();
    const workingPeriod = `${String(state.workingStartHour).padStart(
      2,
      "0"
    )}:${String(state.workingStartMinute).padStart(2, "0")} to ${String(
      state.workingEndHour
    ).padStart(2, "0")}:${String(state.workingEndMinute).padStart(2, "0")}`;
    console.log(
      `🚫 Cron skipped. Currently outside working hours (${workingPeriod} ${
        enableTimezoneRestriction ? TIMEZONE : "local time"
      }). Current time: ${currentTime}`
    );
    // Only send a message if logging is enabled to avoid spam during off-hours
    if (state.isLoggingEnabled) {
      // Optional: send a message indicating cron was skipped due to working hours
      // await safeSendMessage(`⏰ Cron check skipped. Currently outside working hours (${workingPeriod}).`);
    }
    return;
  }

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
  startCheckProcess(false); // Start check, respecting working hour restriction
});

// --- Initial Run and Startup Message ---
(async () => {
  const workingPeriod = `${String(state.workingStartHour).padStart(
    2,
    "0"
  )}:${String(state.workingStartMinute).padStart(2, "0")} to ${String(
    state.workingEndHour
  ).padStart(2, "0")}:${String(state.workingEndMinute).padStart(2, "0")}`;
  let startupMessage = `👋 Bot started. Initial check starting now...\n\nAvailable commands:\n/checknow - Run a single check immediately (bypasses working hour restriction)\n/startat HH:MM - Set the start time for the working period\n/stopat HH:MM - Set the stop time for the working period\n/toggle_log - Toggle sending general logs to Telegram (Warnings and Errors are always sent)\n/shutdown - Stop the bot completely\nOK - Stop appointment alerts`; // Updated command list

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

  startupMessage += `\n\nScheduled checks will run *only* between ${workingPeriod} ${
    enableTimezoneRestriction ? TIMEZONE : "local time"
  }. Use /checknow for an immediate check that bypasses this restriction.`;

  await safeSendMessage(startupMessage);
  // Start the first check immediately, but it will be skipped if outside working hours
  startCheckProcess(false); // Initial check respects working hour restriction
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
