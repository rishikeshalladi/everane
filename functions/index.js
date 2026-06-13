/**
 * Firebase Cloud Functions for Everane Email Reminders
 * 
 * This function runs on a schedule (every hour) and checks which medications
 * need reminders sent based on the user's settings.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');
const twilio = require('twilio');
const webpush = require('web-push');
const cors = require('cors')({ origin: true });
const ScheduleUtils = require('./schedule-utils');

admin.initializeApp();

// ---- Web Push (VAPID) configuration ----------------------------------------
const vapidPublic = functions.config().vapid?.public || process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = functions.config().vapid?.private || process.env.VAPID_PRIVATE_KEY;
const vapidSubject = functions.config().vapid?.subject || process.env.VAPID_SUBJECT || 'mailto:support@everane.app';
if (vapidPublic && vapidPrivate) {
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    console.log('✅ Web Push (VAPID) configured');
  } catch (e) {
    console.error('❌ Web Push VAPID setup failed:', e.message);
  }
} else {
  console.warn('⚠️ Web Push VAPID keys missing — push notifications will not be sent');
}

// Convert a medication's stored reminder setting into a channel Set.
// Supports both new `reminderChannels` array and legacy `reminderMethod` single-char codes.
function getMedChannels(med) {
  const out = new Set();
  if (med && Array.isArray(med.reminderChannels)) {
    for (const c of med.reminderChannels) {
      const v = String(c || '').toLowerCase();
      if (v === 'email' || v === 'sms' || v === 'push') out.add(v);
    }
    return out;
  }
  const m = med && med.reminderMethod;
  if (m === 'E' || m === 'Email') out.add('email');
  else if (m === 'S' || m === 'SMS') out.add('sms');
  else if (m === 'ES') { out.add('email'); out.add('sms'); }
  return out;
}

// Configure your email service (Gmail example)
// For production, use environment config: firebase functions:config:set gmail.email="your@gmail.com" gmail.password="your-app-password"
const gmailEmail = functions.config().gmail?.email || process.env.GMAIL_EMAIL;
const gmailPassword = functions.config().gmail?.password || process.env.GMAIL_PASSWORD;

// Base URL for the app (for email links)
// For production, set: firebase functions:config:set app.baseurl="https://everane.live"
// Or use environment variable: APP_BASE_URL
const APP_BASE_URL = functions.config().app?.baseurl || process.env.APP_BASE_URL || 'https://everane.live';

// Twilio configuration
// firebase functions:config:set twilio.account_sid="AC..." twilio.auth_token="..." twilio.from_number="+1..."
const twilioAccountSid = functions.config().twilio?.account_sid || process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = functions.config().twilio?.auth_token || process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = functions.config().twilio?.from_number || process.env.TWILIO_FROM_NUMBER;
// Initialize Twilio client for SMS
let twilioClient = null;
if (twilioAccountSid && twilioAuthToken) {
  try {
    twilioClient = twilio(twilioAccountSid, twilioAuthToken);
    console.log('✅ Twilio SMS client initialized');
  } catch (e) {
    console.error('❌ Twilio client init failed:', e.message);
  }
} else {
  console.error('⚠️ TWILIO SMS CONFIGURATION MISSING:');
  console.error('  SMS sending will fail. Please configure Twilio credentials.');
  console.error('  Run: firebase functions:config:set twilio.account_sid="AC..." twilio.auth_token="..." twilio.from_number="+1..."');
}


// Verify email configuration
if (!gmailEmail || !gmailPassword) {
  console.error('⚠️ EMAIL CONFIGURATION MISSING:');
  console.error(`  gmailEmail: ${gmailEmail ? 'SET' : 'MISSING'}`);
  console.error(`  gmailPassword: ${gmailPassword ? 'SET' : 'MISSING'}`);
  console.error('  Email sending will fail. Please configure Gmail credentials.');
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: gmailEmail,
    pass: gmailPassword // Use App Password, not regular password
  }
});

// Verify transporter is configured
transporter.verify(function(error, success) {
  if (error) {
    console.error('❌ EMAIL TRANSPORTER VERIFICATION FAILED:', error);
  } else {
    console.log('✅ Email transporter verified successfully');
  }
});

/**
 * Generate a unique 7-digit patient ID.
 * Checks Firestore to ensure no collision.
 */
async function generateUniquePatientId(db) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = String(Math.floor(1000000 + Math.random() * 9000000));
    const snap = await db.collection('users').where('patientId', '==', id).limit(1).get();
    if (snap.empty) return id;
  }
  // Fallback: timestamp-based
  return String(Date.now()).slice(-7);
}

/**
 * Helper function to send SMS via Twilio
 * @param {string} phoneNumber - Recipient phone number (E.164 format)
 * @param {string} message - SMS message text
 * @returns {Promise} - Twilio message resource (with .id alias for .sid)
 */
/**
 * Retry a promise-returning function with exponential backoff.
 * Retries on any thrown error up to `attempts` times total (including the first try).
 */
async function withRetry(label, fn, attempts = 3, baseDelayMs = 500) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      console.warn(`[retry] ${label} attempt ${i + 1}/${attempts} failed: ${err.message || err}`);
      if (isLast) break;
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function sendSMS(phoneNumber, message) {
  if (!twilioClient) {
    throw new Error('Twilio SMS client not initialized');
  }

  if (!twilioFromNumber) {
    throw new Error('Twilio from number not configured');
  }

  return withRetry(`sendSMS->${phoneNumber}`, async () => {
    const msg = await twilioClient.messages.create({
      to: phoneNumber,
      from: twilioFromNumber,
      body: message,
    });
    console.log(`✅ SMS queued at Twilio for ${phoneNumber}: sid=${msg && msg.sid} status=${msg && msg.status}`);
    if (msg && (msg.errorCode || msg.errorMessage)) {
      console.warn('  Twilio returned error metadata:', JSON.stringify({
        errorCode: msg.errorCode,
        errorMessage: msg.errorMessage,
      }));
    }
    // Preserve legacy callers that read result.id (Sinch shape) by aliasing sid.
    if (msg && !msg.id) {
      try { msg.id = msg.sid; } catch (_) {}
    }
    return msg;
  }, 3, 750);
}

/**
 * Query Twilio for the delivery status of a previously-sent message.
 * Returns null if Twilio is not configured. Otherwise returns a normalized
 * shape compatible with the old Sinch payload: { status, code, ... } where
 *   - status: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | etc.
 *   - code: Twilio errorCode (e.g. 30007 carrier filtered) or null
 *
 * Note: SMS delivery reports can take 5-60+ seconds to populate. Polling
 * immediately after sending often returns "queued"/"sent" — wait before
 * "delivered"/"failed" appear.
 */
async function getSmsDeliveryStatus(messageSid, recipient) {
  if (!twilioClient || !messageSid) return null;
  try {
    const m = await twilioClient.messages(messageSid).fetch();
    return {
      status: m.status,           // queued | sending | sent | delivered | undelivered | failed
      code: m.errorCode || null,  // numeric Twilio error code (30003/30005/30007 = carrier issues)
      errorMessage: m.errorMessage || null,
      sid: m.sid,
      to: m.to,
      from: m.from,
      dateSent: m.dateSent,
      dateUpdated: m.dateUpdated,
    };
  } catch (e) {
    return { error: (e && e.message) || String(e), statusCode: e && e.status };
  }
}

/**
 * Send a Web Push notification to every subscription on record for a user.
 * Automatically prunes subscriptions that come back 404/410 (gone).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} userId
 * @param {Array} subscriptions  Array of {endpoint, keys:{p256dh,auth}, userAgent, createdAt}
 * @param {Object} payload       {title, body, tag?, data?, icon?, badge?, actions?}
 */

/**
 * Persist a per-attempt audit record to Firestore so we can debug delivery
 * failures without depending on the rate-limited Cloud Logging API.
 * Writes one tiny doc per (channel, medId, time, offset, date) attempt.
 * Auto-trims to the most recent 200 entries to keep doc count bounded.
 */
async function recordSendAttempt(db, userId, attempt) {
  try {
    const now = Date.now();
    const id = `${now}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      ts: new Date(now).toISOString(),
      channel: attempt.channel || 'unknown',         // 'email' | 'sms' | 'push'
      medId: attempt.medId || null,
      medName: attempt.medName || null,
      doseNumber: attempt.doseNumber || null,
      doseTime: attempt.doseTime || null,
      offsetKey: attempt.offsetKey || null,
      date: attempt.date || null,
      status: attempt.status || 'unknown',           // 'sent' | 'failed' | 'skipped'
      reason: attempt.reason || null,
      error: attempt.error ? String(attempt.error).slice(0, 500) : null
    };
    await db.collection('users').doc(userId).collection('sendAuditLog').doc(id).set(entry);
  } catch (e) {
    console.warn('[Audit] Failed to record attempt:', e.message);
  }
}

async function sendPushToSubscriptions(db, userId, subscriptions, payload) {
  if (!vapidPublic || !vapidPrivate) {
    console.warn('[Push] VAPID not configured, skipping');
    return { sent: 0, pruned: 0 };
  }
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return { sent: 0, pruned: 0 };
  }
  const body = JSON.stringify(payload);
  const stillValid = [];
  const dead = [];
  let sent = 0;
  for (const sub of subscriptions) {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        body,
        {
          // urgency:'high' tells the push service to deliver immediately even
          // when the device is idle / in Doze mode. Critical for medication
          // reminders that must arrive on time.
          urgency: 'high',
          // TTL = how long the push service holds the message if the device is
          // unreachable. 1 hour is plenty for a med reminder.
          TTL: 60 * 60,
          headers: {
            // FCM-specific: also set the priority header so Chrome on Android
            // wakes the device. Ignored by other push services.
            Urgency: 'high'
          }
        }
      );
      stillValid.push(sub);
      sent++;
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        console.log(`[Push] Pruning dead subscription (${status}) for user ${userId}`);
        dead.push(sub.endpoint);
      } else {
        console.warn(`[Push] sendNotification failed (${status || '?'}):`, err.message || err);
        // Keep the subscription around — could be transient
        stillValid.push(sub);
      }
    }
  }
  if (dead.length > 0) {
    try {
      await db.collection('users').doc(userId).set({
        pushSubscriptions: stillValid
      }, { merge: true });
    } catch (e) {
      console.warn('[Push] Failed to prune dead subscriptions:', e.message);
    }
  }
  return { sent, pruned: dead.length };
}

/**
 * Build a push payload for a SINGLE medication dose reminder.
 * Each medication/dose gets its own individual notification rather than
 * being bundled — users asked for one per event at the same time.
 */
function buildSingleMedPushPayload(med, reminderTime, offsetKey, userTimezone, todayIso) {
  const time12 = format12Hour(reminderTime);
  const isAtTime = offsetKey === 'at_time';
  const doseNumber = med._doseNumber || 1;
  const dosage = med.dosage ? ` — ${med.dosage}` : '';
  const name = med.name || 'Medication';

  let title;
  if (isAtTime) {
    title = med._isAlreadyTaken ? `${name} (already taken)` : `Time for ${name}`;
  } else {
    title = `Reminder: ${name} at ${time12}`;
  }

  const bodyLines = [`${name}${dosage}`];
  if (doseNumber) bodyLines.push(`Dose #${doseNumber} at ${time12}`);
  if (med._isAlreadyTaken) bodyLines.push('Already marked taken.');

  const url = `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(name)}&dose=${doseNumber}&time=${encodeURIComponent(reminderTime || '')}&date=${todayIso}&medId=${encodeURIComponent(med.id || '')}`;

  // Only show Taken / Not Taken action buttons at the actual dose time,
  // and only if the dose isn't already marked taken.
  const showActions = isAtTime && !med._isAlreadyTaken;

  return {
    title,
    body: bodyLines.join('\n'),
    // Unique tag per medication+dose+offset so multiple same-time meds each show
    // as their own notification in the OS tray (not coalesced).
    tag: `rem-${todayIso}-${reminderTime}-${offsetKey}-${med.id || name}-d${doseNumber}`,
    // Keep at-time reminders on screen until the user dismisses them, so a
    // medication reminder isn't missed because the notification auto-disappeared
    // after a few seconds while the phone was face-down.
    requireInteraction: showActions,
    // If a follow-up notification with the same tag arrives, re-alert (sound/vibrate)
    // instead of silently replacing.
    renotify: true,
    data: {
      url,
      userTimezone: userTimezone || null,
      medId: med.id || null,
      medName: name,
      doseNumber,
      doseTime: reminderTime,
      doseDate: todayIso,
      actionable: showActions
    },
    actions: showActions ? [
      { action: 'taken', title: 'Taken' },
      { action: 'not_taken', title: 'Not Taken' }
    ] : []
  };
}

/**
 * Determines reminder times based on medication settings
 * @param {Object} med - Medication object
 * @returns {Array} - Array of time strings in HH:MM format
 */
function getReminderTimes(med, nowDateTime) {
  // New: Use schedules if available
  if (med.schedules && med.schedules.length > 0) {
    const now = nowDateTime || getNowInZone();
    const doses = ScheduleUtils.getScheduledDosesForDate(med.schedules, now);
    const times = doses.map(d => d.time).filter(Boolean);
    return times.length > 0 ? times : ['09:00'];
  }

  // Existing fallback logic
  // If user provided specific times, use those
  if (med.times && med.times.length > 0) {
    return med.times;
  }

  // Otherwise, use defaults based on timesPerDay
  const timesPerDay = med.timesPerDay || 1;

  if (timesPerDay === 1) {
    return ['09:00'];
  } else if (timesPerDay === 2) {
    return ['09:00', '21:00'];
  } else if (timesPerDay === 3) {
    return ['09:00', '15:00', '21:00'];
  } else if (timesPerDay > 3) {
    // For more than 3/day, use the 3-time schedule
    return ['09:00', '15:00', '21:00'];
  }

  return ['09:00']; // Default fallback
}

/**
 * Checks if medication should send reminder today
 * @param {Object} med - Medication object
 * @returns {boolean}
 */
const DEFAULT_TIME_ZONE = 'America/Los_Angeles'; // Fallback if user timezone not set
const LOW_STOCK_DOSE_THRESHOLD = 10; // Warn when fewer than this many doses remain
const EXPIRING_SOON_DAYS = 30; // Warn when a bottle expires within this many days
// Once the target time has passed, we send the reminder the very next time the function runs
// (as long as we haven't already sent it — tracked via lastSentReminders).
// WINDOW_MINUTES is now only used as a *cap* on how far in the future we look ahead for advance
// reminders on the "tomorrow" branch. It no longer acts as a narrow send window, which was
// causing reminders to be dropped whenever Cloud Scheduler had jitter > 2 minutes.
const WINDOW_MINUTES = 10;
// Safety cap: don't send reminders more than this many minutes late (prevents a backlog of
// old reminders blasting out if the function was down for hours).
const MAX_SEND_LATENESS_MINUTES = 180;
const EXPIRATION_ALERT_DAYS = 7;

function getNowInZone(userTimezone = null) {
  const tz = userTimezone || DEFAULT_TIME_ZONE;
  return DateTime.now().setZone(tz);
}

function parseEndDate(dateStr, userTimezone = null) {
  if (!dateStr || dateStr === 'N/A') return null;
  const tz = userTimezone || DEFAULT_TIME_ZONE;
  const parsed = DateTime.fromFormat(dateStr, 'M/d/yyyy', { zone: tz });
  if (parsed.isValid) {
    return parsed.endOf('day');
  }
  const isoParsed = DateTime.fromISO(dateStr, { zone: tz });
  return isoParsed.isValid ? isoParsed.endOf('day') : null;
}

function shouldSendReminderToday(med, nowDateTime = getNowInZone()) {
  const weekdayIndex = nowDateTime.weekday % 7;
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = weekdays[weekdayIndex];

  if (med.deletedStatus === true) return false;

  const userTimezone = nowDateTime.zoneName;
  const endDate = parseEndDate(med.endDate, userTimezone);
  if (endDate && nowDateTime > endDate) return false;

  if (med.schedules && med.schedules.length > 0) {
    return ScheduleUtils.isScheduledForDate(med.schedules, nowDateTime);
  }

  const daysOfWeek = med.daysOfWeek || med.days || [];
  if (daysOfWeek.length > 0) {
    const normalizedDays = daysOfWeek.map(day => {
      if (typeof day === 'number') return weekdays[day % 7];
      return String(day).toLowerCase();
    });
    if (!normalizedDays.includes(todayName)) return false;
  }

  return true;
}

function parseBottleRecord(bottleStr) {
  if (!bottleStr || typeof bottleStr !== 'string') return null;

  const parts = bottleStr.split('/');
  if (parts.length < 3) return null;

  const expirationStr = `${parts[0]}/${parts[1]}/${parts[2]}`;
  
  // Note: parseBottleExpiration is called from getBottleAlertsForUser which receives nowDateTime
  // The timezone should be passed from the caller, but for backward compatibility, use DEFAULT_TIME_ZONE
  // Try M/d/yyyy format first (e.g., "12/14/2025")
  let expiration = DateTime.fromFormat(expirationStr, 'M/d/yyyy', { zone: DEFAULT_TIME_ZONE });
  
  // If that fails, try MM/dd/yyyy format (e.g., "12/14/2025" with padding)
  if (!expiration.isValid) {
    expiration = DateTime.fromFormat(expirationStr, 'MM/dd/yyyy', { zone: DEFAULT_TIME_ZONE });
  }
  
  // If that fails, try ISO format (YYYY-MM-DD)
  if (!expiration.isValid) {
    expiration = DateTime.fromISO(expirationStr, { zone: DEFAULT_TIME_ZONE });
  }
  
  if (!expiration.isValid) return null;

  const quantityPart = parts[3];
  const quantity = quantityPart && quantityPart !== 'N/A' ? Number(quantityPart) : null;

  return { expiration, quantity };
}

/**
 * Analyze a single medication's current bottle situation.
 * Returns an array of alert objects with severity and type.
 * Types: 'expired', 'out_of_stock', 'low_stock', 'expiring_soon'
 */
function analyzeMedicationStock(med, nowDateTime) {
  const alerts = [];
  const medName = med.name || 'Medication';
  const dosage = Number(med.dosage) || 1;

  const bottles = Array.isArray(med.bottles)
    ? med.bottles.map(parseBottleRecord).filter(Boolean)
    : [];

  // Case: no bottles entered at all
  if (bottles.length === 0) {
    alerts.push({
      medName,
      type: 'out_of_stock',
      severity: 'critical',
      message: `${medName} has no bottles entered. Please order new ones and add them to the app.`
    });
    return alerts;
  }

  // Sort by expiration date (earliest first)
  const sorted = [...bottles].sort((a, b) => a.expiration.toMillis() - b.expiration.toMillis());

  // The "current/active" bottle is the earliest one that isn't expired AND has stock left.
  // Fall back to earliest if none match.
  const activeBottle = sorted.find(b => b.expiration > nowDateTime && (b.quantity === null || b.quantity > 0))
    || sorted[0];

  const allExpired = sorted.every(b => b.expiration <= nowDateTime);
  const totalRemaining = sorted.reduce((sum, b) => {
    if (b.expiration <= nowDateTime) return sum; // skip expired
    if (b.quantity === null) return sum + Infinity; // N/A quantity = treat as unlimited
    return sum + b.quantity;
  }, 0);

  // Case 1: EXPIRED — active bottle is already past expiration
  if (activeBottle.expiration <= nowDateTime) {
    const dateLabel = activeBottle.expiration.toFormat('MMM d, yyyy');
    alerts.push({
      medName,
      type: 'expired',
      severity: 'critical',
      message: allExpired
        ? `${medName} expired on ${dateLabel}. Order new ones.`
        : `${medName} had a bottle expire on ${dateLabel}. Switch to one of your other bottles.`
    });
    // Don't return yet — still check low stock / expiring soon on other bottles
  }

  // Case 2: OUT OF STOCK — all non-expired bottles have quantity 0
  if (totalRemaining === 0 && !allExpired) {
    alerts.push({
      medName,
      type: 'out_of_stock',
      severity: 'critical',
      message: `${medName} is out of stock. Order new ones.`
    });
    return alerts;
  }

  // Only run the remaining checks against the active (non-expired) bottle
  if (activeBottle.expiration <= nowDateTime) {
    return alerts; // already flagged as expired
  }

  // Case 3: LOW STOCK — current bottle has fewer than threshold doses left
  if (activeBottle.quantity !== null && activeBottle.quantity > 0 && dosage > 0) {
    const dosesRemaining = Math.floor(activeBottle.quantity / dosage);
    if (dosesRemaining <= LOW_STOCK_DOSE_THRESHOLD) {
      alerts.push({
        medName,
        type: 'low_stock',
        severity: 'warning',
        dosesRemaining,
        message: dosesRemaining === 0
          ? `${medName} is about to run out — 0 doses left in your current bottle.`
          : `${medName} is running low — only ${dosesRemaining} dose${dosesRemaining === 1 ? '' : 's'} left in your current bottle.`
      });
    }
  }

  // Case 4: EXPIRING SOON — current bottle expires within 30 days
  const daysUntilExpiration = activeBottle.expiration.diff(nowDateTime, 'days').days;
  if (daysUntilExpiration > 0 && daysUntilExpiration <= EXPIRING_SOON_DAYS) {
    const dateLabel = activeBottle.expiration.toFormat('MMM d, yyyy');
    const daysLabel = Math.ceil(daysUntilExpiration);
    alerts.push({
      medName,
      type: 'expiring_soon',
      severity: 'warning',
      daysRemaining: daysLabel,
      message: `${medName} expires on ${dateLabel} (${daysLabel} day${daysLabel === 1 ? '' : 's'}).`
    });
  }

  return alerts;
}

async function getBottleAlertsForUser(uid, nowDateTime = getNowInZone()) {
  const alerts = [];
  const medsSnapshot = await admin.firestore()
    .collection('users')
    .doc(uid)
    .collection('medications')
    .get();

  medsSnapshot.forEach(doc => {
    const med = { id: doc.id, ...doc.data() };

    // Skip deleted medications
    if (med.deletedStatus === true) return;

    const medAlerts = analyzeMedicationStock(med, nowDateTime);
    alerts.push(...medAlerts);
  });

  // Sort critical first, then warnings
  alerts.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'critical' ? -1 : 1;
  });

  return alerts;
}

/**
 * Formats time from 24h to 12h format
 * @param {string} time24 - Time in HH:MM format
 * @returns {string} - Time in 12h format with AM/PM
 */
function format12Hour(time24) {
  const [hours, minutes] = time24.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

const REMINDER_OPTIONS = {
  '1_day_before': {
    minutes: -1440,
    subjectSnippet: 'in 1 day',
    headerLine: 'You have medications scheduled tomorrow.',
    bodyNoteHtml: '⏰ This is a reminder 1 day before your scheduled dose.',
    bodyNoteText: 'This is a reminder 1 day before your scheduled dose.'
  },
  '5_hours_before': {
    minutes: -300,
    subjectSnippet: 'in about 5 hours',
    headerLine: 'You have medications scheduled in about 5 hours.',
    bodyNoteHtml: '⏰ This is a reminder 5 hours before your scheduled dose.',
    bodyNoteText: 'This is a reminder 5 hours before your scheduled dose.'
  },
  '3_hours_before': {
    minutes: -180,
    subjectSnippet: 'in about 3 hours',
    headerLine: 'You have medications scheduled in about 3 hours.',
    bodyNoteHtml: '⏰ This is a reminder 3 hours before your scheduled dose.',
    bodyNoteText: 'This is a reminder 3 hours before your scheduled dose.'
  },
  '2_hours_before': {
    minutes: -120,
    subjectSnippet: 'in about 2 hours',
    headerLine: 'You have medications scheduled in about 2 hours.',
    bodyNoteHtml: '⏰ This is a reminder 2 hours before your scheduled dose.',
    bodyNoteText: 'This is a reminder 2 hours before your scheduled dose.'
  },
  '1_hour_before': {
    minutes: -60,
    subjectSnippet: 'in about 1 hour',
    headerLine: 'You have medications scheduled in about 1 hour.',
    bodyNoteHtml: '⏰ This is a reminder 1 hour before your scheduled dose.',
    bodyNoteText: 'This is a reminder 1 hour before your scheduled dose.'
  },
  '30_minutes_before': {
    minutes: -30,
    subjectSnippet: 'in 30 minutes',
    headerLine: 'You have medications scheduled in about 30 minutes.',
    bodyNoteHtml: '⏰ This is a reminder 30 minutes before your scheduled dose.',
    bodyNoteText: 'This is a reminder 30 minutes before your scheduled dose.'
  },
  '15_minutes_before': {
    minutes: -15,
    subjectSnippet: 'in 15 minutes',
    headerLine: 'You have medications scheduled in 15 minutes.',
    bodyNoteHtml: '⏰ This is a reminder 15 minutes before your scheduled dose.',
    bodyNoteText: 'This is a reminder 15 minutes before your scheduled dose.'
  },
  '10_minutes_before': {
    minutes: -10,
    subjectSnippet: 'in 10 minutes',
    headerLine: 'You have medications scheduled in 10 minutes.',
    bodyNoteHtml: '⏰ This is a reminder 10 minutes before your scheduled dose.',
    bodyNoteText: 'This is a reminder 10 minutes before your scheduled dose.'
  },
  '5_minutes_before': {
    minutes: -5,
    subjectSnippet: 'in 5 minutes',
    headerLine: 'You have medications scheduled in 5 minutes.',
    bodyNoteHtml: '⏰ This is a reminder 5 minutes before your scheduled dose.',
    bodyNoteText: 'This is a reminder 5 minutes before your scheduled dose.'
  },
  at_time: {
    minutes: 0,
    subjectSnippet: 'now',
    headerLine: 'Time to take your medication',
    bodyNoteHtml: null,
    bodyNoteText: null
  }
};

function getReminderOption(key) {
  return REMINDER_OPTIONS[key] || REMINDER_OPTIONS.at_time;
}

/**
 * Determines the current dose for a medication (same logic as home screen)
 * Only sends reminders for the current dose, not future doses
 * @param {Object} med - Medication object
 * @param {DateTime} nowDateTime - Current date/time
 * @returns {Object|null} - Current dose object with {timeStr, doseNumber} or null
 */
function determineCurrentDoseForEmail(med, nowDateTime = getNowInZone()) {
  // New: Use schedules if available
  if (med.schedules && med.schedules.length > 0) {
    return ScheduleUtils.determineCurrentDose(med.schedules, nowDateTime);
  }

  // Existing fallback logic below...
  const weekdaysConst = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekdayIndex = nowDateTime.weekday % 7; // Luxon weekday: Monday=1 ... Sunday=7 -> convert to 0-based Sunday
  const todayName = weekdaysConst[weekdayIndex];
  
  // Get allowed days - handle both string and number formats
  let allowedDays = weekdaysConst; // Default to all days
  const daysOfWeek = med.daysOfWeek || med.days || [];
  if (daysOfWeek.length > 0) {
    allowedDays = daysOfWeek.map(d => {
      if (typeof d === 'number') {
        // Convert number (0-6) to day name
        return weekdaysConst[d % 7];
      }
      return String(d).toLowerCase();
    });
  }
  
  // Get times
  const times = Array.isArray(med.times) && med.times.length > 0 
    ? med.times.filter(Boolean).sort()
    : [];
  
  // Build all dose candidates for today and yesterday
  const candidates = [];
  for (let offset = -1; offset < 7; offset++) {
    const candidateDate = nowDateTime.plus({ days: offset });
    const candidateWeekdayIndex = candidateDate.weekday % 7;
    const weekdayName = weekdaysConst[candidateWeekdayIndex];
    
    if (!allowedDays.includes(weekdayName)) continue;
    
    if (times.length > 0) {
      times.forEach((timeStr, index) => {
        const [h, m] = timeStr.split(':').map(Number);
        if (Number.isNaN(h) || Number.isNaN(m)) return;
        
        const candidateDateTime = candidateDate.set({
          hour: h,
          minute: m,
          second: 0,
          millisecond: 0
        });
        
        candidates.push({
          dateTime: candidateDateTime,
          timeStr: timeStr,
          weekday: weekdayName,
          doseNumber: index + 1,
          totalDoses: times.length
        });
      });
    } else {
      // No times specified - use start of day
      candidates.push({
        dateTime: candidateDate.startOf('day'),
        timeStr: null,
        weekday: weekdayName,
        doseNumber: 1,
        totalDoses: 1
      });
    }
  }
  
  if (candidates.length === 0) {
    return null;
  }
  
  // Sort by dateTime
  candidates.sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
  
  // Find next dose (first dose >= now)
  const nextDose = candidates.find(c => c.dateTime >= nowDateTime);
  
  // Find previous dose (last dose < now)
  const previousDoses = candidates.filter(c => c.dateTime < nowDateTime);
  const previousDose = previousDoses.length > 0 ? previousDoses[previousDoses.length - 1] : null;
  
  // If no next dose, use the first candidate (wraps around)
  if (!nextDose) {
    return candidates[0];
  }
  
  // If no previous dose, use next dose
  if (!previousDose) {
    return nextDose;
  }
  
  // Calculate time differences in minutes
  const timeToNext = nextDose.dateTime.diff(nowDateTime, 'minutes').minutes;
  const timeSincePrevious = nowDateTime.diff(previousDose.dateTime, 'minutes').minutes;
  const timeBetweenDoses = nextDose.dateTime.diff(previousDose.dateTime, 'minutes').minutes;
  
  // Rule 1: If within 45 minutes of previous dose, use previous dose
  if (timeSincePrevious <= 45) {
    return previousDose;
  }
  
  // Rule 2: If next and previous doses are less than 1.5 hours (90 minutes) apart,
  // use whichever is closer to current time
  if (timeBetweenDoses < 90) {
    return timeToNext < timeSincePrevious ? nextDose : previousDose;
  }
  
  // Default: use next dose
  return nextDose;
}

function shouldSendOffsetReminder(reminderTime, offsetMinutes, nowDateTime = getNowInZone()) {
  if (!reminderTime) return false;
  const targetDateTime = computeTargetDateTime(reminderTime, offsetMinutes, nowDateTime);
  if (!targetDateTime) {
    console.log(`  -> shouldSendOffsetReminder: Invalid targetDateTime for ${reminderTime} with offset ${offsetMinutes}`);
    return false;
  }

  // Send iff: now >= target AND we're not absurdly late (>3h), AND still within the same calendar day.
  // Deduplication is handled by lastSentReminders, so sending "at or after target" will still
  // only send ONCE per reminder per day — it just won't be dropped due to Cloud Function jitter.
  if (nowDateTime < targetDateTime) {
    return false; // haven't reached target yet
  }
  const diffMinutes = nowDateTime.diff(targetDateTime, 'minutes').minutes;
  if (diffMinutes > MAX_SEND_LATENESS_MINUTES) {
    // Too stale — don't send a dose reminder hours after the fact.
    return false;
  }
  // Don't cross day boundaries: if target was yesterday in user's zone, drop it.
  if (nowDateTime.toISODate() !== targetDateTime.toISODate()) {
    return false;
  }
  console.log(`  -> shouldSendOffsetReminder: ${reminderTime} [offset=${offsetMinutes}], diff=${diffMinutes.toFixed(1)}min, shouldSend=true, now=${nowDateTime.toFormat('HH:mm')}, target=${targetDateTime.toFormat('HH:mm')}`);
  return true;
}

function computeTargetDateTime(reminderTime, offsetMinutes, nowDateTime = getNowInZone()) {
  if (!reminderTime) return null;
  const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
  if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) {
    console.warn(`Invalid reminder time string: ${reminderTime}`);
    return null;
  }

  const reminderDateTime = nowDateTime.set({
    hour: reminderHour,
    minute: reminderMinute,
    second: 0,
    millisecond: 0
  });

  // Always return today's date — the caller (shouldSendOffsetReminder) handles
  // whether now is within the send window. No bumping to tomorrow.
  return reminderDateTime.plus({ minutes: offsetMinutes });
}

/**
 * Variant of computeTargetDateTime for tomorrow's doses.
 * Used for large advance reminders like 1_day_before where we need to
 * check tomorrow's dose and see if the reminder fires today.
 */
function computeTargetDateTimeTomorrow(reminderTime, offsetMinutes, nowDateTime = getNowInZone()) {
  if (!reminderTime) return null;
  const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
  if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) return null;

  const reminderDateTime = nowDateTime.plus({ days: 1 }).set({
    hour: reminderHour,
    minute: reminderMinute,
    second: 0,
    millisecond: 0
  });

  return reminderDateTime.plus({ minutes: offsetMinutes });
}

async function buildTodaysSchedule(uid, nowDateTime = getNowInZone()) {
  const scheduleEntries = [];
  const medsSnapshot = await admin.firestore().collection('users').doc(uid).collection('medications').get();

  for (const medDoc of medsSnapshot.docs) {
    const med = { id: medDoc.id, ...medDoc.data() };
    if (med.deletedStatus === true) continue;
    if (!shouldSendReminderToday(med, nowDateTime)) continue;

    if (med.schedules && med.schedules.length > 0) {
      const doses = ScheduleUtils.getScheduledDosesForDate(med.schedules, nowDateTime);
      doses.forEach(dose => {
        scheduleEntries.push({
          time: dose.time,
          name: med.name || 'Medication',
          dosage: med.dosage || null,
          doseNumber: dose.doseNumber,
          totalDoses: doses.length,
          medId: med.id || medDoc.id
        });
      });
    } else {
      // Existing fallback logic
      const times = Array.isArray(med.times) && med.times.length > 0 ? [...med.times].filter(Boolean).sort() : [null];
      times.forEach((timeStr, index) => {
        scheduleEntries.push({
          time: timeStr,
          name: med.name || 'Medication',
          dosage: med.dosage || null,
          doseNumber: index + 1,
          totalDoses: times.length,
          medId: med.id || medDoc.id
        });
      });
    }
  }

  scheduleEntries.sort((a, b) => {
    if (a.time === b.time) {
      return (a.name || '').localeCompare(b.name || '');
    }
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  return scheduleEntries;
}

async function sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts = [], userTimezone = null, missedYesterday = []) {
  const now = getNowInZone(userTimezone);
  const formattedDate = now.toFormat('EEEE, MMMM d');

  // Build a "missed yesterday" section if applicable. This is the safety net:
  // even if individual missed-dose emails got spam-filtered, the daily agenda
  // surfaces every dose that wasn't taken yesterday.
  const missedYesterdayHtml = (Array.isArray(missedYesterday) && missedYesterday.length > 0)
    ? `
      <div style="margin-top:24px; padding:20px; background:#fef2f2; border:1px solid #ef4444; border-radius:16px;">
        <h3 style="margin:0 0 12px 0; color:#991b1b; font-size:18px;">⚠️ Yesterday's missed dose${missedYesterday.length > 1 ? 's' : ''}</h3>
        <div style="margin-bottom:10px; color:#7f1d1d; font-size:15px;">These doses were not marked taken yesterday and were auto-marked as missed. If you took any of them, you can correct the status in Everane.</div>
        ${missedYesterday.map(m => `
          <div style="margin-bottom:8px; padding:10px 14px; background:white; border-radius:10px; border:1px solid #fca5a5;">
            <span style="font-weight:700; color:#991b1b;">${m.medName}</span>
            <span style="color:#7f1d1d;"> &middot; dose #${m.doseNumber}${m.doseTime ? ' at ' + format12Hour(m.doseTime) : ''}</span>
          </div>
        `).join('')}
      </div>
    `
    : '';

  const scheduleItemsHtml = scheduleEntries.map((entry, index) => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    const doseLabel = entry.totalDoses > 1 ? `Dose ${entry.doseNumber}` : 'Scheduled dose';
    const dosageLabel = entry.dosage ? `<div class="agenda-entry-dose">${entry.dosage}</div>` : '';
    return `
      <div class="agenda-entry">
        <div class="agenda-entry-time">${timeLabel}</div>
        <div class="agenda-entry-body">
          <div class="agenda-entry-name">${doseLabel} · ${entry.name}</div>
          ${dosageLabel}
        </div>
      </div>
    `;
  }).join('');

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
        .wrapper { width:100%; padding:24px 0; }
        .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
        .header { background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:32px 28px; color:white; text-align:center; }
        .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
        .header p { margin:12px 0 0; font-size:17px; font-weight:500; opacity:0.92; }
        .content { padding:32px 28px; line-height:1.7; font-size:18px; }
        .schedule-card { border:1px solid #d7e3ff; border-radius:20px; padding:24px 26px; background:#f7f9ff; }
        .schedule-entry-list { display:grid; gap:14px; }
        .agenda-entry { display:flex; gap:16px; align-items:flex-start; padding:16px 18px; background:white; border-radius:16px; border:1px solid #e1e8ff; box-shadow:inset 0 1px 0 rgba(255,255,255,0.6); }
        .agenda-entry-time { min-width:110px; font-weight:700; color:#2846b2; }
        .agenda-entry-name { font-weight:600; color:#1f2933; }
        .agenda-entry-dose { color:#62708c; font-size:16px; margin-top:4px; }
        .footer { text-align:center; font-size:16px; color:#61718f; padding:24px 28px 32px; background:#f8faff; }
        .cta { display:inline-block; margin-top:24px; padding:14px 28px; border-radius:14px; background:#3f6ff5; color:white; font-weight:700; letter-spacing:0.5px; text-decoration:none; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Today’s Medication Agenda</h1>
            <p>${formattedDate}</p>
          </div>
          <div class="content">
            <div class="schedule-card">
              <div class="schedule-entry-list">
                ${scheduleItemsHtml}
              </div>
            </div>
            ${missedYesterdayHtml}
            ${bottleAlerts.length > 0 ? (() => {
              const criticals = bottleAlerts.filter(a => a.severity === 'critical');
              const warnings = bottleAlerts.filter(a => a.severity === 'warning');
              let html = '';
              if (criticals.length > 0) {
                html += `
                  <div style="margin-top:24px; padding:20px; background:#fee2e2; border:1px solid #ef4444; border-radius:16px;">
                    <h3 style="margin:0 0 12px 0; color:#991b1b; font-size:18px;">🚨 Urgent: Action Needed</h3>
                    ${criticals.map(alert => `
                      <div style="margin-bottom:12px; padding:12px; background:white; border-radius:12px; border:1px solid #fca5a5;">
                        <div style="font-weight:700; color:#991b1b; margin-bottom:4px;">${alert.medName}</div>
                        <div style="color:#991b1b; font-size:15px;">${alert.message}</div>
                      </div>
                    `).join('')}
                  </div>
                `;
              }
              if (warnings.length > 0) {
                html += `
                  <div style="margin-top:${criticals.length > 0 ? '16' : '24'}px; padding:20px; background:#fff3cd; border:1px solid #ffc107; border-radius:16px;">
                    <h3 style="margin:0 0 12px 0; color:#856404; font-size:18px;">⚠️ Heads Up</h3>
                    ${warnings.map(alert => `
                      <div style="margin-bottom:12px; padding:12px; background:white; border-radius:12px; border:1px solid #ffc107;">
                        <div style="font-weight:600; color:#856404; margin-bottom:4px;">${alert.medName}</div>
                        <div style="color:#856404; font-size:15px;">${alert.message}</div>
                      </div>
                    `).join('')}
                  </div>
                `;
              }
              return html;
            })() : ''}
            <p style="margin-top:24px;">This agenda includes every dose scheduled for today. Tap "Taken" in Everane after each medication so we can keep your history up to date.</p>
            <a href="${APP_BASE_URL}/home.html" class="cta">Open Everane</a>
          </div>
          <div class="footer">
            This is an automated message from Everane.<br/>You can update reminder preferences anytime from your profile.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textSchedule = scheduleEntries.map(entry => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    const doseLabel = entry.totalDoses > 1 ? `Dose ${entry.doseNumber}` : 'Scheduled dose';
    return `${timeLabel} — ${doseLabel} · ${entry.name}${entry.dosage ? ` (${entry.dosage})` : ''}`;
  }).join('\n');

  const criticalAlerts = bottleAlerts.filter(a => a.severity === 'critical');
  const warningAlerts = bottleAlerts.filter(a => a.severity === 'warning');
  const textBottleAlerts = bottleAlerts.length > 0 ? [
    '',
    ...(criticalAlerts.length > 0 ? [
      'URGENT — ACTION NEEDED:',
      ...criticalAlerts.map(alert => `  * ${alert.message}`),
      ''
    ] : []),
    ...(warningAlerts.length > 0 ? [
      'HEADS UP:',
      ...warningAlerts.map(alert => `  * ${alert.message}`),
      ''
    ] : [])
  ].join('\n') : '';

  const textBody = [
    `Today's Medication Agenda – ${formattedDate}`,
    '',
    textSchedule,
    textBottleAlerts,
    'This agenda includes every dose scheduled for today. Remember to mark each medication as taken inside Everane after you complete it.',
    '',
    'Everane'
  ].join('\n');

  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: userEmail,
    subject: `Today’s Medication Agenda`,
    text: textBody,
    html: htmlBody
  };

  await transporter.sendMail(mailOptions);
  console.log(`Agenda email sent to ${userEmail} with ${scheduleEntries.length} entries`);
}

/**
 * Sends combined reminder email for multiple medications at the same time
 * @param {string} userEmail - User's email address
 * @param {Array} meds - Array of medication objects
 * @param {string} reminderTime - Time of reminder
 * @param {string} offsetKey - Which reminder preference triggered this email
 * @param {Array} alerts - Array of {med, alertType} objects for alerts
 */
/**
 * Sends email notification for missed doses
 * @param {string} userEmail - User's email address
 * @param {Array} missedDoses - Array of {med, reminderTime, doseNumber, scheduledDateTime} objects
 */
async function sendMissedDoseEmail(userEmail, missedDoses) {
  if (missedDoses.length === 0) return;

  const nowDateTime = getNowInZone();
  const time12 = format12Hour(missedDoses[0].reminderTime);
  // Include the specific dose time + medication name in the subject so each
  // missed-dose email has a unique subject. Gmail aggressively clusters /
  // spam-filters emails with identical subjects sent from the same sender.
  const subject = missedDoses.length === 1
    ? `Missed dose at ${time12}: ${missedDoses[0].med.name}`
    : `${missedDoses.length} missed doses at ${time12}`;
  
  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#ef4444,#dc2626); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .header p { margin:12px 0 0; font-size:17px; font-weight:500; opacity:0.92; }
    .content { background:#f9f9f9; padding:32px 28px; line-height:1.7; font-size:18px; }
    .content-section { margin-bottom:24px; }
    .section-title { font-size:20px; font-weight:700; margin:0 0 14px; color:#244066; letter-spacing:0.3px; }
    .med-info { background:white; padding:24px 24px 20px; border-radius:18px; margin-bottom:18px; border-left:5px solid #ef4444; box-shadow:0 6px 18px rgba(239,68,68,0.12); }
    .med-name { font-size:20px; font-weight:700; color:#23407a; margin:0 0 10px; }
    .dose-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
    .dose-chip { display:inline-flex; align-items:center; padding:6px 14px; background:#fee2e2; color:#991b1b; border-radius:999px; font-weight:600; letter-spacing:0.3px; }
    .time-badge { display:inline-flex; align-items:center; padding:6px 14px; border-radius:999px; background:#ef4444; color:white; font-weight:600; letter-spacing:0.3px; }
    .detail { margin:8px 0; font-size:16px; color:#44506b; }
    .label { font-weight:700; color:#1f2933; }
    .warning-box { background:#fef2f2; padding:22px; border-radius:18px; margin-bottom:18px; border-left:5px solid #ef4444; color:#991b1b; box-shadow:0 6px 18px rgba(239,68,68,0.16); }
    .warning-title { font-size:18px; font-weight:700; margin:0 0 8px; }
    .cta-wrap { text-align:center; margin-top:30px; }
    .cta { display:inline-block; padding:14px 32px; border-radius:14px; background:#ef4444; color:white; font-weight:700; letter-spacing:0.5px; text-decoration:none; box-shadow:0 12px 24px rgba(239,68,68,0.28); }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
  `;
  
  const medSections = missedDoses.map(({ med, reminderTime, doseNumber, scheduledDateTime }) => {
    const time12 = format12Hour(reminderTime);
    const doseLabel = missedDoses.length > 1 ? `Dose #${doseNumber}` : 'Scheduled dose';
    return `
      <div class="med-info">
        <p class="med-name">${med.name}</p>
        <div class="dose-row">
          <span class="dose-chip">${doseLabel}</span>
          <span class="time-badge">${time12}</span>
        </div>
        <div class="detail"><span class="label">Dosage:</span> ${med.dosage || 'N/A'}</div>
        <div class="detail"><span class="label">Scheduled time:</span> ${time12}</div>
      </div>
    `;
  }).join('');
  
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>⚠️ Missed Dose${missedDoses.length > 1 ? 's' : ''}</h1>
            <p>You missed ${missedDoses.length === 1 ? 'a dose' : 'some doses'}. Please review below.</p>
          </div>
          <div class="content">
            <div class="warning-box">
              <p class="warning-title">⚠️ Missed Medication${missedDoses.length > 1 ? 's' : ''}</p>
              <div>We noticed you haven't marked ${missedDoses.length === 1 ? 'this dose' : 'these doses'} as taken. ${missedDoses.length === 1 ? 'It' : 'They'} ${missedDoses.length === 1 ? 'has' : 'have'} been automatically marked as "Not Taken".</div>
              <div style="margin-top: 12px;">If this is a mistake and you did take ${missedDoses.length === 1 ? 'it' : 'them'}, please update the status in Everane.</div>
            </div>
            <div class="content-section">
              <h2 class="section-title">Missed ${missedDoses.length === 1 ? 'Dose' : 'Doses'}</h2>
              ${medSections}
            </div>
            <div class="cta-wrap">
              <a class="cta" href="${APP_BASE_URL}/home.html">Update in Everane</a>
            </div>
          </div>
          <div class="footer">
            This is an automated notification from Everane.<br/>
            Doses are automatically marked as "Not Taken" if not marked within the scheduled window.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const textLines = [];
  textLines.push(`Missed Dose${missedDoses.length > 1 ? 's' : ''} Notification`);
  textLines.push('');
  textLines.push(`We noticed you haven't marked ${missedDoses.length === 1 ? 'this dose' : 'these doses'} as taken. ${missedDoses.length === 1 ? 'It' : 'They'} ${missedDoses.length === 1 ? 'has' : 'have'} been automatically marked as "Not Taken".`);
  textLines.push('');
  textLines.push('MISSED DOSES:');
  missedDoses.forEach(({ med, reminderTime, doseNumber }) => {
    const time12 = format12Hour(reminderTime);
    textLines.push(`${med.name} - Dose #${doseNumber}`);
    textLines.push(`Scheduled: ${time12}`);
    textLines.push('');
  });
  textLines.push('If this is a mistake and you did take the medication, please update the status in Everane.');
  textLines.push('');
  textLines.push('Everane');
  
  const textBody = textLines.join('\n');
  
  // Anti-spam hardening: same headers as the main reminder email so Gmail
  // recognises this as transactional (and not as bulk identical messages).
  // Each call gets a unique X-Entity-Ref-ID so identical-looking missed-dose
  // emails are never bucketed by Gmail's "similar messages" heuristic.
  const refId = `MISSED-${nowDateTime.toFormat('yyyyLLdd-HHmm')}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubMailto = `mailto:${gmailEmail}?subject=${encodeURIComponent('Unsubscribe ' + (userEmail || ''))}`;
  const unsubLink   = `${APP_BASE_URL}/profile.html`;

  const mailOptions = {
    from: `Everane Reminders <${gmailEmail}>`,
    to: userEmail,
    replyTo: userEmail || gmailEmail,
    subject,
    text: textBody,
    html: htmlBody,
    headers: {
      'X-Priority': '1',
      'X-Mailer': 'Everane/1.0',
      'X-Entity-Ref-ID': refId,
      'List-Unsubscribe': `<${unsubMailto}>, <${unsubLink}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Precedence': 'transactional'
    }
  };

  try {
    // Use the existing retry wrapper so transient SMTP errors don't kill the alert.
    const result = await withRetry(
      `sendMissedDoseEmail->${userEmail}`,
      () => transporter.sendMail(mailOptions),
      3,
      750
    );
    console.log(`Missed dose email sent to ${userEmail} for ${missedDoses.length} dose(s); messageId=${result && result.messageId}`);
  } catch (error) {
    console.error('Error sending missed dose email:', error.message);
    throw error;
  }
}

/**
 * Checks for missed doses and automatically marks them as "not taken"
 * @param {string} userId - User ID
 * @param {string} userEmail - User email
 * @param {QuerySnapshot} medicationsSnapshot - Medications snapshot
 * @param {DateTime} nowDateTime - Current date/time
 * @param {Firestore} db - Firestore database instance
 */
async function checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, nowDateTime, db, userPhoneNumber = null, phoneVerified = false, pushSubscriptions = [], lastSentReminders = null) {
  // Per-dose dedup keys for missed-dose alerts live in lastSentReminders under
  // a distinct prefix so they can't collide with at-time keys:
  //   MISSED|<medId>|d<doseNumber>|<date>|<channel>
  // If a previous cycle failed to send the email, the key stays unset and the
  // next cycle retries automatically.
  const externalDedup = lastSentReminders && typeof lastSentReminders === 'object';
  const missedDedup = externalDedup ? lastSentReminders : {};

  const missedDoses = [];
  const updates = {}; // Track which medications need auto-mark writes
  
  for (const medDoc of medicationsSnapshot.docs) {
    const rawData = medDoc.data();
    
    // Normalize medication data
    const med = {
      id: medDoc.id,
      name: rawData.name || '',
      dosage: rawData.dosage || '',
      daysOfWeek: rawData.daysOfWeek || rawData.days || [],
      times: Array.isArray(rawData.times) ? rawData.times.filter(Boolean) : [],
      timesPerDay: rawData.timesPerDay || 0,
      reminderMethod: rawData.reminderMethod || 'N',
      reminderChannels: Array.isArray(rawData.reminderChannels) ? rawData.reminderChannels.slice() : undefined,
      deletedStatus: rawData.deletedStatus === true,
      doses: rawData.doses || {}
    };

    // Skip if deleted or no channels selected at all
    const channels = getMedChannels(med);
    if (med.deletedStatus || channels.size === 0) {
      continue;
    }
    
    // Check if medication should send reminder today
    if (!shouldSendReminderToday(med, nowDateTime)) {
      continue;
    }
    
    // === NEW: Get ALL doses for today and check each one for missed status ===
    let allTodayDoses = [];
    // Also need schedules field for getScheduledDosesForDate
    const medSchedules = rawData.schedules || null;
    if (!medSchedules && (med.daysOfWeek.length > 0 || med.times.length > 0)) {
      const migrated = ScheduleUtils.migrateOldFormat(med);
      med.schedules = migrated.schedules;
    } else {
      med.schedules = medSchedules;
    }

    if (med.schedules && med.schedules.length > 0) {
      allTodayDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, nowDateTime);
    } else if (med.times.length > 0) {
      allTodayDoses = med.times.filter(Boolean).sort().map((t, i) => ({ time: t, doseNumber: i + 1 }));
    }

    if (allTodayDoses.length === 0) continue;

    const todayIso = nowDateTime.toISODate();

    for (const dose of allTodayDoses) {
      const doseTime = dose.time;
      if (!doseTime) continue;

      const [doseHour, doseMinute] = doseTime.split(':').map(Number);
      if (Number.isNaN(doseHour) || Number.isNaN(doseMinute)) continue;

      const scheduledDateTime = nowDateTime.set({
        hour: doseHour,
        minute: doseMinute,
        second: 0,
        millisecond: 0
      });

      // Skip future doses
      if (scheduledDateTime > nowDateTime) continue;

      // Check if 45+ minutes have passed
      const minutesPast = nowDateTime.diff(scheduledDateTime, 'minutes').minutes;
      if (minutesPast < 45) continue;

      // Look up the dose entry. If the user manually marked it taken, this is
      // NOT a missed dose — skip entirely.
      const doseKey = `${todayIso}_${dose.doseNumber}`;
      const doseEntry = med.doses[doseKey];
      if (doseEntry && doseEntry.taken === true) continue;

      // Any other state (no entry, or already auto-marked missed but we never
      // successfully sent the email) → this is a missed dose we still owe an
      // alert for. Per-channel dedup at the send stage prevents duplicates.
      console.log(`[Missed Dose] ${med.name} dose #${dose.doseNumber} at ${doseTime} (${Math.floor(minutesPast)} min late)`);

      // Queue an auto-mark write only if not already marked.
      if (!doseEntry) {
        if (!updates[med.id]) {
          updates[med.id] = {
            medDocRef: db.collection('users').doc(userId).collection('medications').doc(med.id),
            doseUpdates: {}
          };
        }
        updates[med.id].doseUpdates[`doses.${doseKey}`] = {
          date: todayIso,
          doseNumber: dose.doseNumber,
          time: doseTime,           // store so daily-agenda safety-net can display it
          taken: false,
          takenAt: null,
          autoMarked: true
        };
      }

      missedDoses.push({
        med,
        reminderTime: doseTime,
        doseNumber: dose.doseNumber,
        scheduledDateTime
      });
    }
  }

  // Save all updates to Firebase using dot-notation updates (won't overwrite other dose keys)
  for (const [medId, update] of Object.entries(updates)) {
    try {
      await update.medDocRef.update(update.doseUpdates);
      console.log(`[Missed Dose] Updated ${update.medDocRef.id} with auto-marked doses`);
    } catch (error) {
      console.error(`[Missed Dose] Error updating ${medId}:`, error);
    }
  }
  
  // Build per-dose dedup keys. Filter out doses we've already emailed/SMSed
  // successfully on a previous cycle today.
  const todayIso = nowDateTime.toISODate();
  const missedKey = (medId, doseNumber, channel) =>
    `MISSED|${medId}|d${doseNumber}|${todayIso}|${channel}`;

  // EMAIL: only doses with email channel AND no successful send yet.
  // SEND ONE EMAIL PER DOSE so Gmail can't bundle/spam-filter "similar"
  // missed-dose emails. Each call goes through sendMissedDoseEmail which
  // gives it a unique subject (with dose time + med name) and a unique
  // X-Entity-Ref-ID.
  const emailMissedDoses = missedDoses.filter(({ med, doseNumber }) => {
    if (!getMedChannels(med).has('email')) return false;
    return !missedDedup[missedKey(med.id, doseNumber, 'email')];
  });
  if (emailMissedDoses.length > 0 && userEmail) {
    for (const m of emailMissedDoses) {
      try {
        // Pass a single-element array so the email is specifically about this dose
        await sendMissedDoseEmail(userEmail, [m]);
        missedDedup[missedKey(m.med.id, m.doseNumber, 'email')] = nowDateTime.toISO();
        await recordSendAttempt(db, userId, {
          channel: 'email', medId: m.med.id, medName: m.med.name,
          doseNumber: m.doseNumber, doseTime: m.reminderTime,
          offsetKey: 'missed', date: todayIso,
          status: 'sent', reason: 'missed-dose alert (per-dose)'
        });
        console.log(`[Missed Dose] Email sent for ${m.med.name} dose #${m.doseNumber}`);
      } catch (error) {
        console.error(`[Missed Dose] Email failed for ${m.med.name} dose #${m.doseNumber}:`, error.message);
        await recordSendAttempt(db, userId, {
          channel: 'email', medId: m.med.id, medName: m.med.name,
          doseNumber: m.doseNumber, doseTime: m.reminderTime,
          offsetKey: 'missed', date: todayIso,
          status: 'failed', error: (error && error.message) || String(error),
          reason: 'missed-dose alert (per-dose)'
        });
        // Key stays unmarked → next minute retries automatically.
      }
    }
  }

  // SMS: only doses with sms channel AND phone verified AND not yet sent
  const smsMissedDoses = missedDoses.filter(({ med, doseNumber }) => {
    if (!getMedChannels(med).has('sms')) return false;
    return !missedDedup[missedKey(med.id, doseNumber, 'sms')];
  });
  if (smsMissedDoses.length > 0) {
    if (userPhoneNumber && phoneVerified) {
      try {
        await sendMissedDoseSMS(userPhoneNumber, smsMissedDoses, nowDateTime);
        for (const m of smsMissedDoses) {
          missedDedup[missedKey(m.med.id, m.doseNumber, 'sms')] = nowDateTime.toISO();
          await recordSendAttempt(db, userId, {
            channel: 'sms', medId: m.med.id, medName: m.med.name,
            doseNumber: m.doseNumber, doseTime: m.reminderTime,
            offsetKey: 'missed', date: todayIso,
            status: 'sent', reason: 'missed-dose alert'
          });
        }
        console.log(`[Missed Dose] SMS sent for ${smsMissedDoses.length} dose(s)`);
      } catch (error) {
        console.error('[Missed Dose] SMS failed:', error.message);
        for (const m of smsMissedDoses) {
          await recordSendAttempt(db, userId, {
            channel: 'sms', medId: m.med.id, medName: m.med.name,
            doseNumber: m.doseNumber, doseTime: m.reminderTime,
            offsetKey: 'missed', date: todayIso,
            status: 'failed', error: (error && error.message) || String(error),
            reason: 'missed-dose alert'
          });
          // SMS frequently fails carrier-side (A2P 10DLC). Mark dedup anyway
          // so we don't burn cycles re-trying against a permanent block.
          missedDedup[missedKey(m.med.id, m.doseNumber, 'sms')] = nowDateTime.toISO();
        }
      }
    } else {
      // Phone unverified — record skipped, mark dedup so we don't retry forever
      for (const m of smsMissedDoses) {
        missedDedup[missedKey(m.med.id, m.doseNumber, 'sms')] = nowDateTime.toISO();
        await recordSendAttempt(db, userId, {
          channel: 'sms', medId: m.med.id, medName: m.med.name,
          doseNumber: m.doseNumber, doseTime: m.reminderTime,
          offsetKey: 'missed', date: todayIso,
          status: 'skipped',
          reason: userPhoneNumber ? 'phone-not-verified' : 'no-phone-on-account'
        });
      }
    }
  }

  // SPEC v2: PUSH is NOT fired for missed doses.

  // Persist updated dedup map. If caller passed `lastSentReminders`, they will
  // persist it themselves at the end of their cycle (avoids double-writes).
  if (!externalDedup) {
    try {
      await db.collection('users').doc(userId).set({
        lastSentReminders: missedDedup
      }, { merge: true });
    } catch (e) {
      console.warn('[Missed Dose] Failed to persist dedup map:', e.message);
    }
  }
}

async function sendCombinedReminderEmail(userEmail, meds, reminderTime, offsetKey = 'at_time', alerts = [], todaysSchedule = [], bottleAlerts = [], userTimezone = null, subjectPrefix = '') {
  const time12 = format12Hour(reminderTime);
  const option = getReminderOption(offsetKey);
  const isAtTime = offsetKey === 'at_time';
  // Get user's timezone for display (default to system timezone if not provided)
  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const todayIndex = nowDateTime.weekday % 7;
  const weekdaysConst = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  // Format timezone abbreviation for display (e.g., "PST", "EST")
  const timezoneAbbr = nowDateTime.toFormat('ZZZZ'); // e.g., "PST", "EST"

  // Build subject line
  let subject;
  const todaysMedListText = [];
  const todaysMedSet = new Set();
  const addTodaysText = (text) => {
    if (!todaysMedSet.has(text)) {
      todaysMedSet.add(text);
      todaysMedListText.push(text);
    }
  };

  const findScheduleEntry = (medId) => {
    if (!Array.isArray(todaysSchedule)) return null;
    return todaysSchedule.find(entry => entry.medId === medId && (entry.time || null) === (reminderTime || null));
  };

  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .header p { margin:12px 0 0; font-size:17px; font-weight:500; opacity:0.92; }
    .content { background:#f9f9f9; padding:32px 28px; line-height:1.7; font-size:18px; }
    .content-section { margin-bottom:24px; }
    .section-title { font-size:20px; font-weight:700; margin:0 0 14px; color:#244066; letter-spacing:0.3px; }
    .med-info { background:white; padding:24px 24px 20px; border-radius:18px; margin-bottom:18px; border-left:5px solid #3f6ff5; box-shadow:0 6px 18px rgba(63,111,245,0.12); }
    .med-name { font-size:20px; font-weight:700; color:#23407a; margin:0 0 10px; }
    .dose-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
    .dose-chip { display:inline-flex; align-items:center; padding:6px 14px; background:#e7edff; color:#1f3c88; border-radius:999px; font-weight:600; letter-spacing:0.3px; }
    .time-badge { display:inline-flex; align-items:center; padding:6px 14px; border-radius:999px; background:#3f6ff5; color:white; font-weight:600; letter-spacing:0.3px; }
    .detail { margin:8px 0; font-size:16px; color:#44506b; }
    .label { font-weight:700; color:#1f2933; }
    .alert-info { background:#fff8f0; padding:22px; border-radius:18px; margin-bottom:18px; border-left:5px solid #f59b45; color:#543210; box-shadow:0 6px 18px rgba(245,155,69,0.16); }
    .alert-title { font-size:18px; font-weight:700; margin:0 0 8px; }
    .closing-note { margin:24px 0 0; font-size:17px; color:#1f2933; }
    .schedule-card { background:white; border-radius:18px; padding:22px; margin-top:18px; border:1px solid #d7e3ff; box-shadow:0 4px 14px rgba(63,111,245,0.08); }
    .schedule-item { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #e5ecff; font-size:17px; color:#27364a; }
    .schedule-item:last-child { border-bottom:none; padding-bottom:0; }
    .schedule-time { font-weight:700; color:#1f3c88; }
    .schedule-name { font-weight:600; padding-left:12px; flex:1; }
    .cta-wrap { text-align:center; margin-top:30px; }
    .cta { display:inline-block; padding:14px 32px; border-radius:14px; background:#3f6ff5; color:white; font-weight:700; letter-spacing:0.5px; text-decoration:none; box-shadow:0 12px 24px rgba(63,111,245,0.28); }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
    .section-divider { border-top:1px solid #d8e2ff; margin:28px 0; }
  `;

  // Include the actual dose time in the subject so every reminder email has a
  // unique subject across the day. Gmail's "looks like a duplicate" heuristic
  // collapses or spam-flags emails with identical subjects in a short window.
  const totalItems = meds.length + alerts.length;
  if (isAtTime) {
    if (totalItems === 1 && meds.length === 1) {
      subject = `Time for ${meds[0].name} (${time12})`;
    } else if (totalItems === 1 && alerts.length === 1) {
      subject = `Stock alert: ${alerts[0].med.name}`;
    } else {
      const remPart = meds.length > 0 ? `${meds.length} reminder${meds.length > 1 ? 's' : ''}` : '';
      const altPart = alerts.length > 0 ? `${alerts.length} alert${alerts.length > 1 ? 's' : ''}` : '';
      const joined = [remPart, altPart].filter(Boolean).join(' + ');
      subject = `${joined} at ${time12}`;
    }
  } else {
    const snippet = option.subjectSnippet || 'soon';
    subject = meds.length === 1
      ? `Upcoming ${snippet} reminder for ${meds[0].name} at ${time12}`
      : `Upcoming ${snippet} reminders (${meds.length} meds) at ${time12}`;
  }

  // Prepend caregiver prefix if forwarding to a caregiver
  if (subjectPrefix) {
    subject = subjectPrefix + subject;
  }

  const headerTitle = isAtTime
    ? `Medication ${totalItems > 1 ? 'Reminders' : 'Reminder'}${alerts.length > 0 ? ' & Alerts' : ''}`
    : `Upcoming Medication Reminder${meds.length > 1 ? 's' : ''}`;
  // Check if any medications are already taken
  const hasTakenMeds = meds.some(med => med._isAlreadyTaken === true);
  const hasUntakenMeds = meds.some(med => med._isAlreadyTaken !== true);
  
  let headerSubtitle;
  if (isAtTime) {
    if (hasTakenMeds && hasUntakenMeds) {
      headerSubtitle = `Some medications are already taken. Review your schedule below. (${time12} ${timezoneAbbr})`;
    } else if (hasTakenMeds && !hasUntakenMeds) {
      headerSubtitle = `All medications for this time have already been taken. (${time12} ${timezoneAbbr})`;
    } else {
      headerSubtitle = meds.length > 0 ? `It's time to take your medication${meds.length > 1 ? 's' : ''} at ${time12} ${timezoneAbbr}.` : 'Please review the following alerts.';
    }
  } else {
    // For advance reminders, show when the medication is scheduled
    const scheduledTimeText = meds.length > 0 && reminderTime ? ` (scheduled for ${time12} ${timezoneAbbr})` : '';
    headerSubtitle = (option.headerLine || 'Here\'s your upcoming medication schedule.') + scheduledTimeText;
  }

  const medSections = meds.map((med, index) => {
    const scheduleEntry = findScheduleEntry(med.id);
    const doseNumber = scheduleEntry
      ? scheduleEntry.doseNumber
      : (meds.length > 1 ? index + 1 : 1);
    const doseLabel = scheduleEntry
      ? `Dose ${scheduleEntry.doseNumber}`
      : (meds.length > 1 ? `Dose ${index + 1}` : 'Scheduled dose');
    const scheduledTime = scheduleEntry && scheduleEntry.time
      ? format12Hour(scheduleEntry.time)
      : time12;
    const scheduledTimeRaw = scheduleEntry && scheduleEntry.time
      ? scheduleEntry.time
      : reminderTime;
    const isAlreadyTaken = med._isAlreadyTaken === true;
    
    // Build URL for email-action.html when isAtTime is true
    const todayIso = nowDateTime.toISODate();
    // Always show link for "take now" emails unless already taken
    const emailActionUrl = isAtTime && !isAlreadyTaken
      ? `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}`
      : null;
    
    // Debug logging for troubleshooting
    console.log(`[Email Template] med: ${med.name}, offsetKey: ${offsetKey}, isAtTime: ${isAtTime}, isAlreadyTaken: ${isAlreadyTaken}, emailActionUrl exists: ${!!emailActionUrl}`);

    if (isAtTime) {
      const takenText = isAlreadyTaken ? ' (Already Taken)' : '';
      addTodaysText(`${doseLabel}: ${scheduledTime} – ${med.name}${takenText}`);
    }

    return `
      <div class="med-info" style="${isAlreadyTaken ? 'border-left-color: #10b981; background: #f0fdf4;' : ''}">
        <p class="med-name">${med.name}${isAlreadyTaken ? ' <span style="color: #10b981; font-size: 16px;">✓ Already Taken</span>' : ''}</p>
        <div class="dose-row">
          <span class="dose-chip">${doseLabel}</span>
          <span class="time-badge">${scheduledTime} ${timezoneAbbr}</span>
        </div>
        <div class="detail"><span class="label">Dosage:</span> ${med.dosage || 'N/A'}</div>
        <div class="detail"><span class="label">Scheduled time:</span> ${scheduledTime} ${timezoneAbbr}</div>
        ${!isAtTime ? `<div class="detail"><span class="label">Reminder sent:</span> ${nowDateTime.toFormat('h:mm a ZZZZ')}</div>` : ''}
        ${med.stock ? `<div class="detail"><span class="label">Bottles in stock:</span> ${med.stock}</div>` : ''}
        ${isAlreadyTaken ? '<div class="detail" style="margin-top: 12px; padding: 12px; background: #d1fae5; border-radius: 8px; color: #065f46;"><strong>✓ This medication was already marked as taken.</strong> No action needed.</div>' : ''}
        ${isAtTime && !isAlreadyTaken ? `<div class="detail" style="margin-top: 12px;"><a href="${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}" style="display: inline-block; padding: 10px 20px; background: #3f6ff5; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Take your dose</a></div>` : ''}
      </div>
    `;
  }).join('');

  const alertsHtml = alerts.length > 0 ? `
    <div class="section-divider"></div>
    <div class="content-section">
      <h2 class="section-title">Alerts</h2>
      ${alerts.map(({ med, alertType }) => {
        const alertIcon = alertType === 'noBottles' ? '⚠️' : '📦';
        const alertTitle = alertType === 'noBottles' ? 'No Bottles Entered' : 'Out of Stock';
        const alertMessage = alertType === 'noBottles'
          ? 'Please add bottle information so we can track your medication supply.'
          : 'Your medication stock is empty. Please arrange a refill soon.';
        return `
          <div class="alert-info">
            <p class="alert-title">${alertIcon} ${alertTitle}: ${med.name}</p>
            <div>${alertMessage}</div>
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  const criticalBottleAlerts = bottleAlerts.filter(a => a.severity === 'critical');
  const warningBottleAlerts = bottleAlerts.filter(a => a.severity === 'warning');
  const bottleAlertsHtml = bottleAlerts.length > 0 ? `
    <div class="section-divider"></div>
    <div class="content-section">
      ${criticalBottleAlerts.length > 0 ? `
        <h2 class="section-title" style="color:#991b1b;">🚨 Urgent: Action Needed</h2>
        ${criticalBottleAlerts.map(alert => `
          <div style="margin-bottom:12px; padding:16px; background:#fee2e2; border:1px solid #ef4444; border-left:5px solid #dc2626; border-radius:14px;">
            <div style="font-weight:700; color:#991b1b; font-size:17px; margin-bottom:4px;">${alert.medName}</div>
            <div style="color:#991b1b; font-size:15px;">${alert.message}</div>
          </div>
        `).join('')}
      ` : ''}
      ${warningBottleAlerts.length > 0 ? `
        <h2 class="section-title" style="color:#856404; ${criticalBottleAlerts.length > 0 ? 'margin-top:20px;' : ''}">⚠️ Heads Up</h2>
        ${warningBottleAlerts.map(alert => `
          <div style="margin-bottom:12px; padding:16px; background:#fff8e1; border:1px solid #ffc107; border-left:5px solid #f59b45; border-radius:14px;">
            <div style="font-weight:700; color:#856404; font-size:17px; margin-bottom:4px;">${alert.medName}</div>
            <div style="color:#856404; font-size:15px;">${alert.message}</div>
          </div>
        `).join('')}
      ` : ''}
    </div>
  ` : '';

  let todaysScheduleHtml = '';
  if (isAtTime && Array.isArray(todaysSchedule) && todaysSchedule.length > 0) {
    const sortedSchedule = [...todaysSchedule].sort((a, b) => {
      if (a.time === b.time) return (a.name || '').localeCompare(b.name || '');
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

    todaysScheduleHtml = `
      <div class="schedule-card">
        <h2 class="section-title" style="margin-bottom:12px;">Today’s Full Schedule</h2>
        ${sortedSchedule.map(entry => {
          const displayTime = entry.time ? `${format12Hour(entry.time)} ${timezoneAbbr}` : 'Any time';
          const doseLabel = entry.doseNumber ? `Dose ${entry.doseNumber}` : 'Scheduled dose';
          const itemText = `${doseLabel}: ${displayTime} – ${entry.name}`;
          addTodaysText(itemText);
          return `<div class="schedule-item"><span class="schedule-time">${displayTime}</span><span class="schedule-name">${doseLabel} — ${entry.name}</span></div>`;
        }).join('')}
      </div>
    `;
  }

  let closingHtmlLine = '';
  if (isAtTime && meds.length > 0) {
    if (hasTakenMeds && !hasUntakenMeds) {
      closingHtmlLine = `<p class="closing-note">✅ All medications for this time have already been taken. No action needed.</p>`;
    } else if (hasTakenMeds && hasUntakenMeds) {
      closingHtmlLine = `<p class="closing-note">✅ Some medications are already taken. Please mark the remaining ones as "Taken" in Everane.</p>`;
    } else {
      closingHtmlLine = `<p class="closing-note">✅ Please tap "Taken" in Everane after each dose so we can keep your history up to date.</p>`;
    }
  } else if (!isAtTime && option.bodyNoteHtml) {
    closingHtmlLine = `<p class="closing-note">${option.bodyNoteHtml}</p>`;
  }

  const remindersSection = meds.length > 0 ? `
    <div class="content-section">
      <h2 class="section-title">${isAtTime ? 'Take these now' : 'Upcoming reminders'}</h2>
      ${medSections}
    </div>
  ` : '';

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>${headerTitle}</h1>
            <p>${headerSubtitle}</p>
            ${reminderTime ? `<p style="margin-top: 8px; font-size: 16px; opacity: 0.9;">⏰ ${isAtTime ? 'Time: ' : 'Scheduled for: '}${time12} ${timezoneAbbr}</p>` : ''}
          </div>
          <div class="content">
            ${remindersSection || '<div class="content-section"><p>No reminders to show.</p></div>'}
            ${alertsHtml}
            ${closingHtmlLine}
            ${todaysScheduleHtml}
            ${bottleAlertsHtml}
            <div class="cta-wrap">
              <a class="cta" href="${APP_BASE_URL}/home.html">Open Everane</a>
            </div>
          </div>
          <div class="footer">
            This is an automated reminder from Everane.<br/>
            You can update reminder times anytime from your profile.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textLines = [];
  textLines.push(`Medication Reminder${!isAtTime ? ` (Upcoming ${option.subjectSnippet})` : ''}`);
  textLines.push('');

  if (meds.length > 0) {
    textLines.push('REMINDERS:');
    meds.forEach((med, index) => {
      const doseLabel = meds.length > 1 ? `Dose ${index + 1}` : 'Scheduled dose';
      const isAlreadyTaken = med._isAlreadyTaken === true;
      textLines.push(`${doseLabel}: ${med.name}${isAlreadyTaken ? ' (Already Taken ✓)' : ''}`);
      textLines.push(`Time: ${time12} ${timezoneAbbr}`);
      if (med.dosage) textLines.push(`Dosage: ${med.dosage}`);
      if (isAlreadyTaken) {
        textLines.push('Status: This medication was already marked as taken. No action needed.');
      } else {
        textLines.push('Instructions: Take with water unless directed otherwise.');
      }
      textLines.push('');
    });
  }

  if (alerts.length > 0) {
    textLines.push('ALERTS:');
  if (bottleAlerts.length > 0) {
    textLines.push('BOTTLE ALERTS:');
    bottleAlerts.forEach(alert => {
      textLines.push(`${alert.medName}: ${alert.message}`);
      textLines.push('');
    });
  }

    alerts.forEach(({ med, alertType }) => {
      textLines.push(`${med.name} - ${alertType === 'noBottles' ? 'NO BOTTLES ENTERED' : 'OUT OF STOCK'}`);
      textLines.push(alertType === 'noBottles' ? 'Please add bottle information.' : 'Please refill soon.');
      textLines.push('');
    });
  }

  if (isAtTime && todaysMedListText.length > 0) {
    textLines.push('TODAY’S SCHEDULE:');
    todaysMedListText.forEach(line => textLines.push(`• ${line}`));
    textLines.push('');
  }

  if (textLines[textLines.length - 1] !== '') {
    textLines.push('');
  }
  textLines.push('Everane');

  const textBody = textLines.join('\n');

  // Anti-spam hardening: make each reminder email look transactional, not bulk.
  // Without these headers, Gmail flags repeating reminders as Promotions/Spam.
  const reminderRef = `${nowDateTime.toFormat('yyyyLLdd-HHmm')}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubMailto = `mailto:${gmailEmail}?subject=${encodeURIComponent('Unsubscribe ' + (userEmail || ''))}`;
  const unsubLink = `${APP_BASE_URL}/profile.html`; // user manages reminders in profile

  const mailOptions = {
    from: `Everane Reminders <${gmailEmail}>`,
    to: userEmail,
    replyTo: userEmail || gmailEmail, // makes thread look like a conversation, not bulk
    subject,
    text: textBody,
    html: htmlBody,
    headers: {
      // Tell Gmail this is a transactional message
      'X-Priority': '1',
      'X-Mailer': 'Everane/1.0',
      'X-Entity-Ref-ID': reminderRef,
      // RFC 8058 / RFC 2369 — Gmail strongly prefers transactional senders that
      // include unsubscribe headers. They also dedupe identical messages without it.
      'List-Unsubscribe': `<${unsubMailto}>, <${unsubLink}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      // Gmail-specific: hints this is a personal/transactional message
      'Precedence': 'transactional'
    }
  };

  try {
    console.log(`[sendCombinedReminderEmail] Attempting to send email:`);
    console.log(`  To: ${userEmail}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  From: ${gmailEmail}`);
    console.log(`  Medications: ${meds.length}`);
    console.log(`  Alerts: ${alerts.length}`);

    if (!gmailEmail || !gmailPassword) {
      throw new Error('Email configuration missing - cannot send email');
    }

    const result = await withRetry(
      `sendCombinedReminderEmail->${userEmail}`,
      () => transporter.sendMail(mailOptions),
      3,
      750
    );
    console.log(`✅ Combined reminder email sent successfully to ${userEmail}`);
    console.log(`  Message ID: ${result.messageId}`);
    console.log(`  Response: ${result.response}`);
    return result;
  } catch (error) {
    console.error('❌ Error sending combined email:', error);
    console.error(`  Error code: ${error.code}`);
    console.error(`  Error command: ${error.command}`);
    console.error(`  Error response: ${error.response}`);
    throw error;
  }
}

/**
 * Sends combined reminder SMS for multiple medications at the same time.
 * Stock / bottle alerts are intentionally email-only and are NOT included in SMS,
 * even when `alerts` or `bottleAlerts` are passed in (they are ignored).
 * @param {string} phoneNumber - User's phone number (E.164 format)
 * @param {Array} meds - Array of medication objects
 * @param {string} reminderTime - Time of reminder
 * @param {string} offsetKey - Which reminder preference triggered this SMS
 * @param {Array} alerts - IGNORED for SMS (email-only)
 * @param {Array} todaysSchedule - Array of schedule entries for dose number lookup
 * @param {Array} bottleAlerts - IGNORED for SMS (email-only)
 * @param {string} userTimezone - User's timezone
 */
async function sendCombinedReminderSMS(phoneNumber, meds, reminderTime, offsetKey = 'at_time', alerts = [], todaysSchedule = [], bottleAlerts = [], userTimezone = null) {
  if (!twilioClient || !twilioFromNumber) {
    throw new Error('Twilio not configured - cannot send SMS');
  }

  const time12 = format12Hour(reminderTime);
  const option = getReminderOption(offsetKey);
  const isAtTime = offsetKey === 'at_time';
  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const timezoneAbbr = nowDateTime.toFormat('ZZZZ');

  const findScheduleEntry = (medId) => {
    if (!Array.isArray(todaysSchedule)) return null;
    return todaysSchedule.find(entry => entry.medId === medId && (entry.time || null) === (reminderTime || null));
  };

  let messageParts = [];

  // Build medication reminders
  if (meds.length > 0) {
    const untakenMeds = meds.filter(m => !m._isAlreadyTaken);
    const takenMeds = meds.filter(m => m._isAlreadyTaken);

    if (isAtTime) {
      if (untakenMeds.length > 0) {
        messageParts.push(`[Everane] Medication Reminder - ${time12} ${timezoneAbbr}`);
        messageParts.push('');
        untakenMeds.forEach((med, index) => {
          const scheduleEntry = findScheduleEntry(med.id);
          const doseNumber = scheduleEntry ? scheduleEntry.doseNumber : (med._doseNumber || (index + 1));
          const doseLabel = `Dose #${doseNumber}`;
          const scheduledTimeRaw = scheduleEntry && scheduleEntry.time ? scheduleEntry.time : reminderTime;
          const todayIso = nowDateTime.toISODate();
          const link = `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}`;
          messageParts.push(`- ${med.name}${med.dosage ? ' (' + med.dosage + ')' : ''} - ${doseLabel}`);
          messageParts.push(`  Take now: ${link}`);
          messageParts.push('');
        });
      }
      if (takenMeds.length > 0) {
        if (untakenMeds.length === 0) {
          messageParts.push(`[Everane] ${time12} ${timezoneAbbr} - All taken`);
          messageParts.push('');
        }
        takenMeds.forEach((med) => {
          messageParts.push(`- ${med.name}${med.dosage ? ' (' + med.dosage + ')' : ''} - Already taken`);
        });
        messageParts.push('');
      }
    } else {
      const minutes = Math.abs(option.minutes);
      const snippet = option.subjectSnippet || `in ${minutes} min`;
      messageParts.push(`[Everane] Upcoming ${snippet} - ${time12} ${timezoneAbbr}`);
      messageParts.push('');
      untakenMeds.forEach((med, index) => {
        const scheduleEntry = findScheduleEntry(med.id);
        const doseNumber = scheduleEntry ? scheduleEntry.doseNumber : (med._doseNumber || (index + 1));
        const scheduledTimeRaw = scheduleEntry && scheduleEntry.time ? scheduleEntry.time : reminderTime;
        const todayIso = nowDateTime.toISODate();
        const link = `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}`;
        messageParts.push(`- ${med.name}${med.dosage ? ' (' + med.dosage + ')' : ''}`);
        messageParts.push(`  Take now: ${link}`);
        messageParts.push('');
      });
      if (takenMeds.length > 0) {
        takenMeds.forEach((med) => {
          messageParts.push(`- ${med.name} - Already taken`);
        });
        messageParts.push('');
      }
    }
  }

  // Stock / bottle alerts are intentionally NOT sent over SMS — they are an
  // email-only feature. The `alerts` and `bottleAlerts` arguments are ignored
  // for SMS to keep messages short and focused on dose timing.

  const fullMessage = messageParts.join('\n');

  try {
    const result = await sendSMS(phoneNumber, fullMessage);
    console.log(`✅ Combined reminder SMS sent successfully to ${phoneNumber}`);
    console.log(`  Medications: ${meds.length}`);
    return result; // includes batch id, useful for delivery status polling
  } catch (error) {
    console.error('❌ Error sending combined SMS:', error);
    throw error;
  }
}

/**
 * Sends daily agenda SMS.
 * Stock / bottle alerts are intentionally email-only and are NOT included in SMS,
 * even when `bottleAlerts` is passed in (it is ignored).
 * @param {string} phoneNumber - User's phone number
 * @param {Array} scheduleEntries - Array of schedule entry objects
 * @param {Array} bottleAlerts - IGNORED for SMS (email-only)
 * @param {string} userTimezone - User's timezone
 */
async function sendDailyAgendaSMS(phoneNumber, scheduleEntries, bottleAlerts = [], userTimezone = null) {
  if (!twilioClient || !twilioFromNumber) {
    throw new Error('Twilio not configured - cannot send SMS');
  }

  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const formattedDate = nowDateTime.toFormat('MMMM d, yyyy');

  let messageParts = [`Today's Medication Agenda - ${formattedDate}`, ''];

  // Add schedule
  scheduleEntries.forEach(entry => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    messageParts.push(`${timeLabel} - ${entry.name}${entry.dosage ? ` (${entry.dosage})` : ''}`);
  });

  // Stock / bottle alerts are intentionally NOT sent over SMS — they are an
  // email-only feature. The `bottleAlerts` argument is ignored for SMS.

  messageParts.push('');
  messageParts.push(`Open Everane: ${APP_BASE_URL}/home.html`);

  const fullMessage = messageParts.join('\n');

  try {
    await sendSMS(phoneNumber, fullMessage);
    console.log(`✅ Daily agenda SMS sent to ${phoneNumber} with ${scheduleEntries.length} entries`);
  } catch (error) {
    console.error('❌ Error sending daily agenda SMS:', error);
    throw error;
  }
}

/**
 * Sends missed dose SMS
 * @param {string} phoneNumber - User's phone number
 * @param {Array} missedDoses - Array of {med, reminderTime, doseNumber, scheduledDateTime} objects
 */
async function sendMissedDoseSMS(phoneNumber, missedDoses, nowDateTime = null) {
  if (missedDoses.length === 0) return;

  if (!twilioClient || !twilioFromNumber) {
    throw new Error('Twilio not configured - cannot send SMS');
  }

  const now = nowDateTime || getNowInZone();

  let messageParts = ['Missed Dose Alert', ''];

  missedDoses.forEach(({ med, reminderTime, doseNumber }) => {
    const time12 = format12Hour(reminderTime);
    const todayIso = now.toISODate();
    const link = `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(reminderTime || 'no-time')}&date=${todayIso}&medId=${med.id}`;
    messageParts.push(`${med.name}${med.dosage ? ' - ' + med.dosage : ''} (Dose #${doseNumber})`);
    messageParts.push(`Scheduled: ${time12}`);
    messageParts.push('');
    messageParts.push(`Auto-marked as Not Taken. If you took it, update here: ${link}`);
    messageParts.push('');
  });

  const fullMessage = messageParts.join('\n');

  try {
    await sendSMS(phoneNumber, fullMessage);
    console.log(`✅ Missed dose SMS sent to ${phoneNumber} for ${missedDoses.length} doses`);
  } catch (error) {
    console.error('❌ Error sending missed dose SMS:', error);
    throw error;
  }
}

/**
 * Sends medication reminder email (DEPRECATED - use sendCombinedReminderEmail)
 * @param {string} userEmail - User's email address
 * @param {Object} med - Medication object
 * @param {string} reminderTime - Time of reminder
 * @param {boolean} isAdvance - Whether this is a 30-min advance reminder
 */
async function sendReminderEmail(userEmail, med, reminderTime, isAdvance = false) {
  const time12 = format12Hour(reminderTime);
  const subject = isAdvance 
    ? `Upcoming: ${med.name} reminder in 30 minutes`
    : `Medication Reminder: ${med.name}`;
  
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
        .med-info { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea; }
        .med-name { font-size: 24px; font-weight: bold; color: #667eea; margin: 0 0 10px 0; }
        .detail { margin: 8px 0; }
        .label { font-weight: bold; color: #555; }
        .footer { text-align: center; color: #777; font-size: 12px; margin-top: 20px; }
        .time-badge { display: inline-block; background: #667eea; color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>💊 ${isAdvance ? 'Upcoming' : ''} Medication Reminder</h1>
          ${isAdvance ? '<p>You have a medication to take in 30 minutes</p>' : '<p>Time to take your medication</p>'}
        </div>
        <div class="content">
          <div class="med-info">
            <p class="med-name">${med.name}</p>
            <div class="detail"><span class="label">Dosage:</span> ${med.dosage || 'N/A'}</div>
            <div class="detail"><span class="label">Time:</span> <span class="time-badge">${time12}</span></div>
            ${med.stock ? `<div class="detail"><span class="label">Bottles in stock:</span> ${med.stock}</div>` : ''}
          </div>
          
          ${isAdvance ? '<p>⏰ This is a 30-minute advance reminder. You\'ll receive another reminder at the scheduled time.</p>' : '<p>✅ Remember to mark this dose as taken in your Everane app!</p>'}
          
          <p style="text-align: center; margin-top: 30px;">
            <a href="${APP_BASE_URL}/home.html" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block;">Open Everane</a>
          </p>
        </div>
        <div class="footer">
          <p>This is an automated reminder from Everane</p>
          <p>To change your reminder settings, visit your profile</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  const textBody = `
Medication Reminder ${isAdvance ? '(30 minutes advance)' : ''}

${med.name}
Dosage: ${med.dosage || 'N/A'}
Time: ${time12}
${med.stock ? `Bottles in stock: ${med.stock}` : ''}

${isAdvance ? 'This is a 30-minute advance reminder.' : 'Remember to mark this dose as taken!'}

Everane
  `;
  
  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: userEmail,
    subject: subject,
    text: textBody,
    html: htmlBody
  };
  
  try {
    await transporter.sendMail(mailOptions);
    console.log(`Reminder email sent to ${userEmail} for ${med.name} at ${reminderTime}`);
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

/**
 * Main scheduled function - runs every 5 minutes
 * Checks all users and sends medication reminders as needed
 * Combines multiple reminders at the same time into ONE email
 */
exports.sendMedicationReminders = functions.pubsub
  .schedule('every 1 minutes') // Run every minute for tighter timing
  .timeZone('UTC') // Use UTC for schedule, then convert to each user's timezone
  .onRun(async (context) => {
    console.log('Starting medication reminder check...');
    console.log('Current UTC time:', new Date().toISOString());
    
    const db = admin.firestore();
    
    try {
      // Get all users
      const usersSnapshot = await db.collection('users').get();
      console.log(`Found ${usersSnapshot.size} users`);
      
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const userData = userDoc.data();
        const userEmail = userData.email;

        console.log(`Checking user: ${userId}, email: ${userEmail}`);

        // Auto-backfill patientId if missing
        if (!userData.patientId) {
          try {
            const newId = await generateUniquePatientId(db);
            await db.collection('users').doc(userId).set({ patientId: newId }, { merge: true });
            console.log(`[Backfill] Assigned patientId ${newId} to ${userId}`);
          } catch (bErr) {
            console.warn(`[Backfill] Failed for ${userId}:`, bErr.message);
          }
        }

        if (!userEmail) {
          console.log(`User ${userId} has no email, skipping...`);
          continue;
        }

        // Wrap each user in try/catch like daily agenda does
        try {
          // Get user's timezone (default to Pacific if not set)
          const userTimezone = userData.timezone || DEFAULT_TIME_ZONE;
          const userNowDateTime = getNowInZone(userTimezone);
          console.log(`User timezone: ${userTimezone}, current time: ${userNowDateTime.toISO()}`);
        
        // Get all medications for this user (we'll filter deleted ones in code)
        const medicationsSnapshot = await db
          .collection('users')
          .doc(userId)
          .collection('medications')
          .get();
        
        console.log(`Found ${medicationsSnapshot.size} medications for user ${userId}`);
        
        if (medicationsSnapshot.size === 0) {
          console.log(`  -> No medications found, skipping user ${userId}`);
          continue;
        }
        
        // Determine reminder preferences from profile with defaults
        const rawPreferences = Array.isArray(userData.notification_reminders) ? userData.notification_reminders : [];
        let reminderPreferences = Array.from(new Set(rawPreferences.filter(pref => REMINDER_OPTIONS[pref])));
        if (reminderPreferences.length === 0) {
          reminderPreferences = ['30_minutes_before', 'at_time'];
        }
        console.log(`Reminder preferences for ${userId}: ${JSON.stringify(reminderPreferences)}`);
        
        // Get last sent reminders to prevent duplicates
        const lastSentReminders = userData.lastSentReminders || {};
        const todayIso = userNowDateTime.toISODate();

        // Group medications by actual send window (preference + time)
        const sendGroups = {}; // key => { meds: [], reminderTime, offsetKey, emailMeds: [], smsMeds: [] }
        const alertMeds = []; // Medications with alerts (no bottles, out of stock, etc.)
        
        // Get user's phone number and verification status
        const userPhoneNumber = userData.phone || null;
        const phoneVerified = userData.phoneVerified === true;
        const userPushSubscriptions = Array.isArray(userData.pushSubscriptions) ? userData.pushSubscriptions : [];
        const todaysSchedule = [];
        const scheduleKeys = new Set();
        const _diagMeds = []; // Collect per-med status for a single summary log

        for (const medDoc of medicationsSnapshot.docs) {
          const rawData = medDoc.data();
          
          // Normalize medication data to handle different formats
          const med = {
            id: medDoc.id,
            name: rawData.name || '',
            dosage: rawData.dosage || '',
            // Handle both daysOfWeek and days fields (daysOfWeek is preferred)
            daysOfWeek: rawData.daysOfWeek || rawData.days || [],
            times: Array.isArray(rawData.times) ? rawData.times.filter(Boolean) : [],
            timesPerDay: rawData.timesPerDay || 0,
            startDate: rawData.startDate || null,
            endDate: rawData.endDate || null,
            reminderMethod: rawData.reminderMethod || 'N',
            reminderChannels: Array.isArray(rawData.reminderChannels) ? rawData.reminderChannels.slice() : undefined,
            bottles: Array.isArray(rawData.bottles) ? rawData.bottles : [],
            stock: rawData.stock || (Array.isArray(rawData.bottles) ? rawData.bottles.length : 0),
            deletedStatus: rawData.deletedStatus === true,
            doses: rawData.doses || {},
            schedules: rawData.schedules || null
          };

          // Auto-migrate old format to schedules if needed
          if (!med.schedules && (med.daysOfWeek.length > 0 || med.times.length > 0)) {
            const migrated = ScheduleUtils.migrateOldFormat(med);
            med.schedules = migrated.schedules;
            console.log(`  -> Auto-migrated ${med.name} to schedules format (${migrated.schedules.length} entries)`);
          }

          // Skip if medication is deleted
          if (med.deletedStatus === true) {
            _diagMeds.push(`${med.name}:DEL`);
            continue;
          }

          // Determine enabled channels (email / sms / push) from new reminderChannels or legacy reminderMethod
          const channels = getMedChannels(med);
          const isEmailReminder = channels.has('email');
          const isSMSReminder = channels.has('sms');
          const isPushReminder = channels.has('push');

          if (!isEmailReminder && !isSMSReminder && !isPushReminder) {
            _diagMeds.push(`${med.name}:noChannels`);
            continue;
          }
          
          // Stock/expiration alerts are now handled centrally by getBottleAlertsForUser()
          // which is called below and passed into sendCombinedReminderEmail as bottleAlerts.
          
          // Check if medication should send reminder today (using user's timezone)
          const shouldSendToday = shouldSendReminderToday(med, userNowDateTime);
          
          if (!shouldSendToday) {
            _diagMeds.push(`${med.name}:!today`);
            continue;
          }

          // === NEW: Get ALL doses for today, not just "current" dose ===
          const todayIsoDate = userNowDateTime.toISODate();
          let allTodayDoses = [];

          if (med.schedules && med.schedules.length > 0) {
            allTodayDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, userNowDateTime);
          } else {
            // Fallback for old format
            const reminderTimes = getReminderTimes(med);
            const sortedTimes = [...reminderTimes].filter(Boolean).sort();
            if (sortedTimes.length > 0) {
              allTodayDoses = sortedTimes.map((t, i) => ({ time: t, doseNumber: i + 1, totalDoses: sortedTimes.length }));
            } else {
              allTodayDoses = [{ time: null, doseNumber: 1, totalDoses: 1 }];
            }
          }

          if (allTodayDoses.length === 0) {
            _diagMeds.push(`${med.name}:!doses`);
            continue;
          }

          // Build today's schedule for display (used in emails)
          allTodayDoses.forEach(dose => {
            const key = `${med.id}|${dose.time || 'any'}`;
            if (!scheduleKeys.has(key)) {
              scheduleKeys.add(key);
              todaysSchedule.push({
                time: dose.time,
                name: med.name || 'Medication',
                dosage: med.dosage || null,
                doseNumber: dose.doseNumber,
                totalDoses: allTodayDoses.length,
                medId: med.id
              });
            }
          });

          const doseDiagParts = [];

          // === Loop through EACH dose independently ===
          for (const dose of allTodayDoses) {
            const doseTime = dose.time;
            const doseNumber = dose.doseNumber;
            const doseKey = `${todayIsoDate}_${doseNumber}`;
            const doseEntry = med.doses && med.doses[doseKey] ? med.doses[doseKey] : null;
            const isAlreadyTaken = doseEntry && doseEntry.taken === true;

            if (!doseTime) {
              // No time specified - only send at_time using 9 AM default
              for (const preference of reminderPreferences) {
                if (preference !== 'at_time') continue;
                const option = getReminderOption(preference);
                const shouldSend = shouldSendOffsetReminder('09:00', option.minutes, userNowDateTime);
                if (shouldSend) {
                  const baseKey = `${med.id}|any|${preference}|${todayIso}`;
                  const emailKey = `${baseKey}|email`;
                  const smsKey   = `${baseKey}|sms`;
                  const pushKey  = `${baseKey}|push`;
                  const needEmail = isEmailReminder && !lastSentReminders[emailKey];
                  const needSMS   = isSMSReminder   && !lastSentReminders[smsKey];
                  const needPush  = isPushReminder  && !lastSentReminders[pushKey];
                  if (!needEmail && !needSMS && !needPush) continue;

                  const groupKey = `${preference}|09:00`;
                  if (!sendGroups[groupKey]) {
                    sendGroups[groupKey] = { meds: [], emailMeds: [], smsMeds: [], pushMeds: [], reminderTime: '09:00', offsetKey: preference, channelKeysByMed: {} };
                  }
                  sendGroups[groupKey].meds.push(med);
                  sendGroups[groupKey].channelKeysByMed[med.id] = { email: emailKey, sms: smsKey, push: pushKey };
                  if (needEmail) sendGroups[groupKey].emailMeds.push(med);
                  if (needSMS)   sendGroups[groupKey].smsMeds.push(med);
                  if (needPush)  sendGroups[groupKey].pushMeds.push(med);
                }
              }
              doseDiagParts.push(`d${doseNumber}@?`);
              continue;
            }

            // Validate dose time
            const [doseHour, doseMinute] = doseTime.split(':').map(Number);
            if (Number.isNaN(doseHour) || Number.isNaN(doseMinute)) continue;

            // Check each reminder preference for this dose
            for (const preference of reminderPreferences) {
              if (isAlreadyTaken && preference !== 'at_time') continue;

              const option = getReminderOption(preference);
              const targetDateTime = computeTargetDateTime(doseTime, option.minutes, userNowDateTime);
              if (!targetDateTime) continue;

              const shouldSend = shouldSendOffsetReminder(doseTime, option.minutes, userNowDateTime);

              if (shouldSend) {
                // SPEC v2 — strict channel routing per preference type:
                //   - "at_time" preference: email + SMS + push allowed (per med's channel selection)
                //   - any "before" preference: EMAIL ONLY (no SMS, no push)
                const isAtTimePref = preference === 'at_time';

                // Per-channel dedup keys — partial failures retry only the failed channel.
                const baseKey = `${med.id}|${doseTime}|d${doseNumber}|${preference}|${todayIso}`;
                const emailKey = `${baseKey}|email`;
                const smsKey   = `${baseKey}|sms`;
                const pushKey  = `${baseKey}|push`;

                const needEmail = isEmailReminder && !lastSentReminders[emailKey];
                const needSMS   = isAtTimePref && isSMSReminder  && !lastSentReminders[smsKey];
                const needPush  = isAtTimePref && isPushReminder && !lastSentReminders[pushKey];

                if (!needEmail && !needSMS && !needPush) continue; // all channels already delivered for this dose+offset

                const medWithStatus = { ...med, _isAlreadyTaken: isAlreadyTaken, _doseNumber: doseNumber, _doseTime: doseTime };
                const groupKey = `${preference}|${doseTime}`;
                if (!sendGroups[groupKey]) {
                  sendGroups[groupKey] = {
                    meds: [], emailMeds: [], smsMeds: [], pushMeds: [],
                    reminderTime: doseTime, offsetKey: preference,
                    // Map medId -> per-channel keys so we can mark exactly what succeeded later
                    channelKeysByMed: {}
                  };
                }
                sendGroups[groupKey].meds.push(medWithStatus);
                sendGroups[groupKey].channelKeysByMed[med.id] = { email: emailKey, sms: smsKey, push: pushKey };
                if (needEmail) sendGroups[groupKey].emailMeds.push(medWithStatus);
                if (needSMS)   sendGroups[groupKey].smsMeds.push(medWithStatus);
                if (needPush)  sendGroups[groupKey].pushMeds.push(medWithStatus);
              }
            }

            doseDiagParts.push(`d${doseNumber}@${doseTime}`);
          }

          // === Check TOMORROW's doses for large advance reminders (e.g., 1_day_before) ===
          // Only needed if user has preferences with offset <= -720 minutes (12+ hours)
          const largeAdvancePrefs = reminderPreferences.filter(p => {
            const opt = getReminderOption(p);
            return opt && opt.minutes <= -720;
          });
          if (largeAdvancePrefs.length > 0) {
            const tomorrowDateTime = userNowDateTime.plus({ days: 1 });
            let tomorrowDoses = [];
            if (med.schedules && med.schedules.length > 0) {
              tomorrowDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, tomorrowDateTime);
            } else {
              const reminderTimes = getReminderTimes(med);
              const sortedTimes = [...reminderTimes].filter(Boolean).sort();
              if (sortedTimes.length > 0) {
                tomorrowDoses = sortedTimes.map((t, i) => ({ time: t, doseNumber: i + 1, totalDoses: sortedTimes.length }));
              }
            }
            const tomorrowIso = tomorrowDateTime.toISODate();
            for (const dose of tomorrowDoses) {
              if (!dose.time) continue;
              for (const preference of largeAdvancePrefs) {
                const option = getReminderOption(preference);
                // Use tomorrow's variant to compute target
                const targetDateTime = computeTargetDateTimeTomorrow(dose.time, option.minutes, userNowDateTime);
                if (!targetDateTime) continue;
                // Send once now has reached the target (dedup by lastSentReminders),
                // but don't send if we're absurdly late.
                const diffMinutes = userNowDateTime.diff(targetDateTime, 'minutes').minutes;
                const shouldSend = diffMinutes >= 0 && diffMinutes <= MAX_SEND_LATENESS_MINUTES;
                if (shouldSend) {
                  // SPEC v2: "before" reminders (1_day_before etc.) are EMAIL ONLY.
                  // SMS and push are never fired for advance reminders.
                  const baseKey = `${med.id}|${dose.time}|d${dose.doseNumber}|${preference}|${tomorrowIso}`;
                  const emailKey = `${baseKey}|email`;
                  const needEmail = isEmailReminder && !lastSentReminders[emailKey];
                  if (!needEmail) continue;

                  const medWithStatus = { ...med, _isAlreadyTaken: false, _doseNumber: dose.doseNumber, _doseTime: dose.time };
                  const groupKey = `${preference}|${dose.time}`;
                  if (!sendGroups[groupKey]) {
                    sendGroups[groupKey] = { meds: [], emailMeds: [], smsMeds: [], pushMeds: [], reminderTime: dose.time, offsetKey: preference, channelKeysByMed: {} };
                  }
                  sendGroups[groupKey].meds.push(medWithStatus);
                  // Only email key — sms/push intentionally null so nothing tries to mark them.
                  sendGroups[groupKey].channelKeysByMed[med.id] = { email: emailKey, sms: null, push: null };
                  sendGroups[groupKey].emailMeds.push(medWithStatus);
                }
              }
            }
          }

          _diagMeds.push(`${med.name}:[${doseDiagParts.join(',')}](${med.reminderMethod})`);
        }
        
        // === COMPACT DIAGNOSTIC: single log line with all med statuses ===
        console.log(`[DIAG] ${userEmail} now=${userNowDateTime.toFormat('HH:mm')} prefs=${JSON.stringify(reminderPreferences)} groups=${Object.keys(sendGroups).length} | ${_diagMeds.join(', ')}`);

        // Send grouped emails and SMS (include alerts if offset is at_time at 09:00)
        let sentAtTimeNineAM = false;
        console.log(`\n=== EMAIL & SMS SENDING PHASE ===`);
        console.log(`Total send groups: ${Object.keys(sendGroups).length}`);
        console.log(`User phone: ${userPhoneNumber}, Verified: ${phoneVerified}`);

        // Get bottle alerts once per user (used by all groups + standalone 9 AM alert email)
        const bottleAlerts = await getBottleAlertsForUser(userId, userNowDateTime);

        for (const [groupKey, group] of Object.entries(sendGroups)) {
          if (!group || group.meds.length === 0) {
            console.log(`Skipping empty group: ${groupKey}`);
            continue;
          }

          // Mark 9 AM "at time" group so we don't double-send the standalone alerts email
          if (group.offsetKey === 'at_time' && group.reminderTime === '09:00') {
            sentAtTimeNineAM = true;
          }
          const includeAlerts = []; // old alertMeds system — no longer used

          // Track per-channel success per medication so we can dedup independently:
          //  - emailDelivered[medId] / smsDelivered[medId] / pushDelivered[medId]
          // Each channel only marks its OWN dedup key; a Twilio outage no longer
          // blocks the email-channel retry, and vice-versa.
          const emailDelivered = {};
          const smsDelivered = {};
          const pushDelivered = {};

          // Send EMAIL reminders
          if (group.emailMeds && group.emailMeds.length > 0) {
            try {
              console.log(`\n>>> ATTEMPTING TO SEND EMAIL <<<`);
              console.log(`  Group key: ${groupKey}`);
              console.log(`  Email medications: ${group.emailMeds.length}`);
              console.log(`  Reminder time: ${group.reminderTime}`);
              console.log(`  Offset: ${group.offsetKey}`);
              console.log(`  Alerts: ${includeAlerts.length}`);
              console.log(`  User email: ${userEmail}`);

              await sendCombinedReminderEmail(userEmail, group.emailMeds, group.reminderTime, group.offsetKey, includeAlerts, todaysSchedule, bottleAlerts, userTimezone);

              // All meds in this email send succeeded
              for (const m of group.emailMeds) {
                emailDelivered[m.id] = true;
                await recordSendAttempt(db, userId, {
                  channel: 'email', medId: m.id, medName: m.name,
                  doseNumber: m._doseNumber, doseTime: group.reminderTime,
                  offsetKey: group.offsetKey, date: todayIso, status: 'sent'
                });
              }
              console.log(`✅ SUCCESS: Email sent to ${userEmail} for ${group.emailMeds.length} medications at ${group.reminderTime} [offset=${group.offsetKey}]`);
            } catch (error) {
              console.error(`❌ FAILED to send reminder email to ${userEmail} for ${group.reminderTime} [offset=${group.offsetKey}]:`, error);
              console.error(`  Error details:`, error.message);
              for (const m of group.emailMeds) {
                await recordSendAttempt(db, userId, {
                  channel: 'email', medId: m.id, medName: m.name,
                  doseNumber: m._doseNumber, doseTime: group.reminderTime,
                  offsetKey: group.offsetKey, date: todayIso,
                  status: 'failed', error: error && error.message || String(error)
                });
              }
              // Continue with SMS even if email fails. emailDelivered stays empty for these meds, so they will retry next minute.
            }
          }

          // Send SMS reminders
          // SPEC v2: no email fallback when SMS fails. If user picked email too,
          // it's already firing in the email block above. If user didn't pick email,
          // they explicitly chose SMS-only and we respect that — SMS will retry
          // next minute (smsDelivered stays empty for failed meds).
          if (group.smsMeds && group.smsMeds.length > 0) {
            if (!userPhoneNumber || !phoneVerified) {
              console.log(`  -> SMS unavailable (${userPhoneNumber ? 'not verified' : 'no phone'}). Skipping SMS for this group.`);
              for (const m of group.smsMeds) {
                await recordSendAttempt(db, userId, {
                  channel: 'sms', medId: m.id, medName: m.name,
                  doseNumber: m._doseNumber, doseTime: group.reminderTime,
                  offsetKey: group.offsetKey, date: todayIso,
                  status: 'skipped',
                  reason: userPhoneNumber ? 'phone-not-verified' : 'no-phone-on-account'
                });
              }
              // Mark SMS dedup keys as "done" so we don't retry SMS every minute
              // until phone is added/verified — that would log-spam forever.
              for (const m of group.smsMeds) smsDelivered[m.id] = true;
            } else {
              let smsResult = null;
              let smsThrew = null;
              try {
                console.log(`\n>>> ATTEMPTING TO SEND SMS <<<`);
                console.log(`  Group key: ${groupKey}`);
                console.log(`  SMS medications: ${group.smsMeds.length}`);
                console.log(`  Reminder time: ${group.reminderTime}`);
                console.log(`  Offset: ${group.offsetKey}`);
                console.log(`  User phone: ${userPhoneNumber}`);

                smsResult = await sendCombinedReminderSMS(userPhoneNumber, group.smsMeds, group.reminderTime, group.offsetKey, includeAlerts, todaysSchedule, bottleAlerts, userTimezone);
                console.log(`✅ SMS queued at Twilio (sid=${smsResult && smsResult.sid}) for ${userPhoneNumber}`);
              } catch (error) {
                smsThrew = error;
                console.error(`❌ FAILED to send reminder SMS to ${userPhoneNumber} for ${group.reminderTime} [offset=${group.offsetKey}]:`, error.message);
              }

              if (smsThrew) {
                // Hard failure — Twilio credential/network issue.
                // No fallback email per spec. Just record and let SMS retry next minute.
                for (const m of group.smsMeds) {
                  await recordSendAttempt(db, userId, {
                    channel: 'sms', medId: m.id, medName: m.name,
                    doseNumber: m._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: 'failed', error: smsThrew && smsThrew.message || String(smsThrew)
                  });
                }
              } else {
                // Twilio accepted. Briefly poll for the actual delivery status
                // (catches carrier blocks like 30007 = message filtered, 30003 =
                // unreachable handset, 30005 = unknown destination). No fallback
                // email per spec — if carrier rejected, mark SMS done anyway
                // (so we don't retry SMS every minute against the same carrier
                // block), and email (if user selected it) is already going through
                // the email block.
                const sid = smsResult && (smsResult.sid || smsResult.id);
                let carrierFailed = false;
                let dlrInfo = null;
                if (sid) {
                  for (const waitMs of [3000, 4000]) {
                    await new Promise(r => setTimeout(r, waitMs));
                    const report = await getSmsDeliveryStatus(sid, userPhoneNumber);
                    if (!report) break;
                    dlrInfo = report;
                    const status = String(report.status || '').toLowerCase();
                    if (status === 'delivered') break;
                    if (status === 'failed' || status === 'undelivered') {
                      carrierFailed = true;
                      break;
                    }
                  }
                }

                for (const m of group.smsMeds) {
                  // Mark SMS done in all non-throw paths to avoid retry-loops against
                  // a carrier block. User picked SMS; the carrier said no; we tried.
                  smsDelivered[m.id] = true;
                  await recordSendAttempt(db, userId, {
                    channel: 'sms', medId: m.id, medName: m.name,
                    doseNumber: m._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: carrierFailed ? 'failed' : 'sent',
                    reason: carrierFailed
                      ? `carrier-rejected: status=${dlrInfo && dlrInfo.status} code=${dlrInfo && dlrInfo.code}`
                      : (dlrInfo ? `twilio status=${dlrInfo.status} code=${dlrInfo.code || 'none'}` : `twilio sid=${sid || 'unknown'}`)
                  });
                }
                if (carrierFailed) {
                  console.warn(`⚠️ SMS carrier-rejected (code=${dlrInfo && dlrInfo.code}, status=${dlrInfo && dlrInfo.status}). No fallback per spec.`);
                } else {
                  console.log(`✅ SMS sent to ${userPhoneNumber} (status=${dlrInfo && dlrInfo.status || 'unknown'})`);
                }
              }
            }
          }

          // Send PUSH reminders — one notification PER medication (not bundled)
          // SPEC v2: push only fires at_time. No email fallback if push has no subs;
          // user picked push, if they have no subscribed device, that's on them.
          if (group.pushMeds && group.pushMeds.length > 0 && userPushSubscriptions.length > 0) {
            console.log(`\n>>> ATTEMPTING TO SEND PUSH (one per med) <<<`);
            console.log(`  Group key: ${groupKey}`);
            console.log(`  Push medications: ${group.pushMeds.length}`);
            console.log(`  Subscriptions: ${userPushSubscriptions.length}`);
            let anyPruned = 0;
            for (const pm of group.pushMeds) {
              try {
                const payload = buildSingleMedPushPayload(pm, group.reminderTime, group.offsetKey, userTimezone, todayIso);
                const pushResult = await sendPushToSubscriptions(db, userId, userPushSubscriptions, payload);
                anyPruned += pushResult.pruned;
                if (pushResult.sent > 0) {
                  // At least one device received it — mark this med's push channel done
                  pushDelivered[pm.id] = true;
                  await recordSendAttempt(db, userId, {
                    channel: 'push', medId: pm.id, medName: pm.name,
                    doseNumber: pm._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: 'sent', reason: `${pushResult.sent} device(s)`
                  });
                } else {
                  await recordSendAttempt(db, userId, {
                    channel: 'push', medId: pm.id, medName: pm.name,
                    doseNumber: pm._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: 'failed', reason: `0 devices delivered, ${pushResult.pruned} pruned`
                  });
                }
              } catch (error) {
                console.error(`❌ Push failed for ${pm.name}:`, error.message);
                await recordSendAttempt(db, userId, {
                  channel: 'push', medId: pm.id, medName: pm.name,
                  doseNumber: pm._doseNumber, doseTime: group.reminderTime,
                  offsetKey: group.offsetKey, date: todayIso,
                  status: 'failed', error: error && error.message || String(error)
                });
              }
            }
            const deliveredCount = Object.keys(pushDelivered).length;
            if (deliveredCount > 0) {
              console.log(`✅ Push sent for ${deliveredCount}/${group.pushMeds.length} med(s); pruned ${anyPruned}`);
            } else {
              console.log(`  (no push delivered; pruned ${anyPruned})`);
            }
          } else if (group.pushMeds && group.pushMeds.length > 0 && userPushSubscriptions.length === 0) {
            // SPEC v2: no email fallback when push has no subscribed devices.
            // User picked push; if they have no subscribed device, the notification
            // just doesn't fire. Mark push dedup done to avoid retry-loops.
            for (const m of group.pushMeds) {
              pushDelivered[m.id] = true;
              await recordSendAttempt(db, userId, {
                channel: 'push', medId: m.id, medName: m.name,
                doseNumber: m._doseNumber, doseTime: group.reminderTime,
                offsetKey: group.offsetKey, date: todayIso,
                status: 'skipped', reason: 'no-push-subscriptions'
              });
            }
          }

          // Mark per-channel dedup keys based on what actually delivered.
          // A failed channel does NOT get marked, so it will retry on the next minute.
          let anyChannelSucceeded = false;
          const channelMap = group.channelKeysByMed || {};
          for (const med of group.meds) {
            const keys = channelMap[med.id];
            if (!keys) continue;
            if (emailDelivered[med.id]) {
              lastSentReminders[keys.email] = userNowDateTime.toISO();
              anyChannelSucceeded = true;
              console.log(`  Marked sent: ${keys.email}`);
            }
            if (smsDelivered[med.id]) {
              lastSentReminders[keys.sms] = userNowDateTime.toISO();
              anyChannelSucceeded = true;
              console.log(`  Marked sent: ${keys.sms}`);
            }
            if (pushDelivered[med.id]) {
              lastSentReminders[keys.push] = userNowDateTime.toISO();
              anyChannelSucceeded = true;
              console.log(`  Marked sent: ${keys.push}`);
            }
          }

          if (anyChannelSucceeded) {
            // Forward reminders to opted-in caregivers (once per group, not per-channel)
            try {
              const patientName = userData.name || userEmail;
              await forwardRemindersToCaregiver(db, userId, patientName, group.meds, group.reminderTime, group.offsetKey, userTimezone);
            } catch (cgErr) {
              console.warn(`[CaregiverReminders] Error forwarding for ${userId}:`, cgErr.message);
            }
          } else {
            console.log(`  ⚠️ No channels succeeded for group ${groupKey} — will retry next run`);
          }
        }
        
        if (Object.keys(sendGroups).length === 0) {
          console.log(`No emails to send - no send groups created`);
        }
        
        // Update lastSentReminders in user document
        if (Object.keys(lastSentReminders).length > 0) {
          try {
            // Clean up old entries (older than 2 days).
            // New per-channel format: ".....|date|channel" (channel = email/sms/push).
            // Old format (pre-channel-split): ".....|date" (date is last segment).
            const twoDaysAgo = userNowDateTime.minus({ days: 2 }).toISODate();
            const isoDate = /^\d{4}-\d{2}-\d{2}$/;
            Object.keys(lastSentReminders).forEach(key => {
              const parts = key.split('|');
              const last = parts[parts.length - 1];
              const isChannelKey = last === 'email' || last === 'sms' || last === 'push';
              let keyDate = null;
              if (isChannelKey) {
                // New per-channel formats:
                //   "medId|time|dN|pref|date|channel" (at-time)
                //   "MISSED|medId|dN|date|channel"   (missed-dose)
                // In both, the date sits second-to-last.
                if (parts.length >= 2 && isoDate.test(parts[parts.length - 2])) {
                  keyDate = parts[parts.length - 2];
                }
              } else if (isoDate.test(last)) {
                // Old format: date is last segment.
                keyDate = last;
                // Migrate to new per-channel format so we don't re-fire reminders
                // already delivered today under the old key.
                lastSentReminders[`${key}|email`] = lastSentReminders[key];
                lastSentReminders[`${key}|sms`]   = lastSentReminders[key];
                lastSentReminders[`${key}|push`]  = lastSentReminders[key];
                delete lastSentReminders[key];
              }
              if (keyDate && keyDate < twoDaysAgo) {
                delete lastSentReminders[key];
              }
            });

            await db.collection('users').doc(userId).set({
              lastSentReminders: lastSentReminders
            }, { merge: true });
          } catch (error) {
            console.error(`Failed to update lastSentReminders for ${userId}:`, error);
          }
        }
        
        // SPEC v2: standalone 9 AM bottle/stock alerts email REMOVED.
        // Stock and expiration alerts are now included only in the daily agenda email
        // (see sendDailyAgenda).

        // Check for missed doses (45+ minutes past scheduled time, not marked)
        try {
          // Pass lastSentReminders so missed-dose dedup keys ('MISSED|…') live
          // alongside at-time dedup keys (single source of truth).
          await checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, userNowDateTime, db, userPhoneNumber, phoneVerified, userPushSubscriptions, lastSentReminders);

          // Persist any MISSED keys added by checkAndMarkMissedDoses. Cheap
          // best-effort write — if it fails we'll re-send next cycle, which
          // is the correct retry behaviour.
          await db.collection('users').doc(userId).set({
            lastSentReminders: lastSentReminders
          }, { merge: true });
        } catch (error) {
          console.error(`Failed to check missed doses for ${userId}:`, error);
        }
        
        // Summary log
        console.log(`\n=== SUMMARY FOR USER ${userId} ===`);
        console.log(`  Email: ${userEmail}`);
        console.log(`  Timezone: ${userTimezone}`);
        console.log(`  Current time: ${userNowDateTime.toFormat('yyyy-MM-dd HH:mm:ss')}`);
        console.log(`  Medications checked: ${medicationsSnapshot.size}`);
        console.log(`  Send groups created: ${Object.keys(sendGroups).length}`);
        console.log(`  Bottle alerts found: ${bottleAlerts.length} (${bottleAlerts.filter(a => a.severity === 'critical').length} critical)`);
        console.log(`  Emails queued: ${Object.values(sendGroups).reduce((sum, g) => sum + (g.meds ? g.meds.length : 0), 0)}`);
        console.log(`===================================\n`);

        // Persist a per-cycle summary so we can debug "nothing fired" cases.
        // Only write when something interesting happened OR within 5 min of a dose
        // time, to avoid filling the audit log with idle minutes.
        try {
          const groupCount = Object.keys(sendGroups).length;
          // Determine if we're within 5min of any dose target (any preference) for any med today
          const minutesSinceMidnight = userNowDateTime.hour * 60 + userNowDateTime.minute;
          let nearAnyDoseTime = false;
          for (const ts of Array.from(scheduleKeys)) {
            const t = ts.split('|')[1];
            if (!t || t === 'any') continue;
            const [hh, mm] = t.split(':').map(Number);
            if (Number.isNaN(hh)) continue;
            const doseMin = hh * 60 + mm;
            if (Math.abs(minutesSinceMidnight - doseMin) <= 5) { nearAnyDoseTime = true; break; }
          }
          if (groupCount > 0 || nearAnyDoseTime) {
            await db.collection('users').doc(userId).collection('sendAuditLog').doc(`cycle_${Date.now()}_${Math.random().toString(36).slice(2,6)}`).set({
              ts: new Date().toISOString(),
              channel: 'cycle',
              status: 'summary',
              reason: `groups=${groupCount}, prefs=${JSON.stringify(reminderPreferences)}, nowLocal=${userNowDateTime.toFormat('HH:mm')}, tz=${userTimezone}, meds=${medicationsSnapshot.size}, alerts=${bottleAlerts.length}, nearDose=${nearAnyDoseTime}`
            });
          }
        } catch (auditErr) {
          console.warn('[Audit] Cycle summary write failed:', auditErr.message);
        }
      } catch (error) {
        console.error(`❌ Error processing reminders for user ${userId} (${userEmail}):`, error);
        console.error(`  Error stack:`, error.stack);
        // Persist the user-level error so we don't lose it to log rate-limiting
        try {
          await db.collection('users').doc(userId).collection('sendAuditLog').doc(`err_${Date.now()}_${Math.random().toString(36).slice(2,6)}`).set({
            ts: new Date().toISOString(),
            channel: 'cycle',
            status: 'failed',
            error: (error && error.message) || String(error),
            reason: 'user-loop-uncaught'
          });
        } catch (_) {}
        // Continue with next user even if this one fails
      }
    }
      
      console.log('Medication reminder check completed');
      return null;
    } catch (error) {
      console.error('Error in medication reminder function:', error);
      throw error;
    }
  });

/**
 * DEPRECATED: Stock alerts are now included in sendMedicationReminders at 9 AM
 * Keeping this function for backwards compatibility but it does nothing
 */
exports.sendLowStockAlerts = functions.pubsub
  .schedule('0 9 * * *') // Daily at 9 AM
  .timeZone('America/Los_Angeles') // Seattle - Pacific Time
  .onRun(async (context) => {
    console.log('sendLowStockAlerts called - alerts are now handled by sendMedicationReminders');
    return null;
  });

exports.sendDailyAgenda = functions.pubsub
  .schedule('every 1 minutes') // Run every minute to check each user's 9 AM in their timezone
  .timeZone('UTC') // Use UTC for the schedule, then convert to user timezone
  .onRun(async (context) => {
    console.log('sendDailyAgenda: Function started');
    const usersSnapshot = await admin.firestore().collection('users').get();
    console.log(`sendDailyAgenda: Found ${usersSnapshot.size} users`);

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const userEmail = userData.email;
      if (!userEmail) {
        continue;
      }

      // Get user's timezone (default to Pacific if not set)
      const userTimezone = userData.timezone || DEFAULT_TIME_ZONE;
      const userNow = getNowInZone(userTimezone);
      const todayIso = userNow.toISODate();
      
      // Send agenda once it's 9:00 AM or later in the user's timezone.
      // Duplicates are prevented by the lastAgendaSentDate check below, so we no longer need
      // a narrow 5-minute window (which was causing missed agendas when the function's invocation
      // happened to fall outside 9:00-9:04).
      const currentHour = userNow.hour;
      if (currentHour < 9) {
        continue;
      }

      console.log(`sendDailyAgenda: Checking ${userEmail} (timezone: ${userTimezone}, time: ${userNow.toISO()})`);

      if (userData.lastAgendaSentDate === todayIso) {
        console.log(`Agenda already sent today for ${userEmail}, skipping`);
        continue;
      }

      try {
        const scheduleEntries = await buildTodaysSchedule(userDoc.id, userNow);
        if (!scheduleEntries.length) {
          console.log(`No schedule entries for ${userEmail} today, skipping`);
          continue;
        }

        const bottleAlerts = await getBottleAlertsForUser(userDoc.id, userNow);
        const userPhoneNumber = userData.phone || null;
        const phoneVerified = userData.phoneVerified === true;

        // SPEC v2: only send agenda on channels the user actually uses.
        // Look across all the user's non-deleted meds — if any med has `email`
        // channel selected, send email agenda. Same for `sms`. No push agenda.
        const medsSnap = await admin.firestore().collection('users').doc(userDoc.id).collection('medications').get();
        let hasEmailMed = false;
        let hasSmsMed = false;
        medsSnap.forEach(d => {
          const data = d.data() || {};
          if (data.deletedStatus === true) return;
          const ch = getMedChannels(data);
          if (ch.has('email')) hasEmailMed = true;
          if (ch.has('sms'))   hasSmsMed = true;
        });

        // Compute yesterday's missed doses (safety net so spam-filtered missed-
        // dose emails are still surfaced in the daily agenda).
        const yesterdayIso = userNow.minus({ days: 1 }).toISODate();
        const missedYesterday = [];
        medsSnap.forEach(d => {
          const data = d.data() || {};
          if (data.deletedStatus === true) return;
          const doses = data.doses || {};
          Object.keys(doses).forEach(key => {
            // Dose key format: "YYYY-MM-DD_<doseNumber>"
            if (!key.startsWith(yesterdayIso + '_')) return;
            const entry = doses[key];
            if (!entry || entry.taken !== false) return;
            missedYesterday.push({
              medId: d.id,
              medName: data.name || 'Medication',
              doseNumber: entry.doseNumber || Number(key.split('_')[1]) || 1,
              doseTime: entry.time || ''
            });
          });
        });
        // Sort by dose time for readability
        missedYesterday.sort((a, b) => String(a.doseTime).localeCompare(String(b.doseTime)));

        let sentAny = false;
        if (hasEmailMed) {
          try {
            await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts, userTimezone, missedYesterday);
            sentAny = true;
            console.log(`Daily agenda email sent to ${userEmail}${missedYesterday.length > 0 ? ' (incl. ' + missedYesterday.length + ' missed-yesterday)' : ''}`);
          } catch (e) {
            console.error(`Failed to send daily agenda email for ${userEmail}`, e.message);
          }
        } else {
          console.log(`[Agenda] Skipping email agenda for ${userEmail} — no meds have email channel selected`);
        }

        if (hasSmsMed && userPhoneNumber && phoneVerified) {
          try {
            await sendDailyAgendaSMS(userPhoneNumber, scheduleEntries, bottleAlerts, userTimezone);
            sentAny = true;
            console.log(`Daily agenda SMS sent to ${userPhoneNumber}`);
          } catch (e) {
            console.error(`Failed to send daily agenda SMS for ${userPhoneNumber}`, e.message);
          }
        }

        // Only mark sent if at least one channel actually delivered, so we don't
        // permanently lose the agenda if both fail.
        if (sentAny) {
          await userDoc.ref.set({ lastAgendaSentDate: todayIso }, { merge: true });
        }
      } catch (error) {
        console.error(`Failed to send daily agenda for ${userEmail}`, error);
      }
    }

    return null;
  });

exports.sendAgendaEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in to send your agenda.');
  }

  const uid = context.auth.uid;
  const userRef = admin.firestore().collection('users').doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new functions.https.HttpsError('failed-precondition', 'User profile not found.');
  }

  const userData = userDoc.data();
  const userEmail = userData.email;
  if (!userEmail) {
    throw new functions.https.HttpsError('failed-precondition', 'Please add an email address to your profile before sending your agenda.');
  }

  // Get user's timezone (default to Pacific if not set)
  const userTimezone = userData.timezone || DEFAULT_TIME_ZONE;
  const now = getNowInZone(userTimezone);
  const scheduleEntries = await buildTodaysSchedule(uid, now);
  if (!scheduleEntries.length) {
    throw new functions.https.HttpsError('not-found', 'No medications scheduled for today.');
  }

  const bottleAlerts = await getBottleAlertsForUser(uid, now);
  await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts, userTimezone);
  await userRef.set({ lastAgendaSentDate: now.toISODate() }, { merge: true });

  return { status: 'success' };
});

/**
 * Sends email verification code for registration
 * @param {string} email - User's email address
 * @param {string} code - 6-digit verification code
 */
async function sendEmailVerificationCode(email, code) {
  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .content { padding:32px 28px; line-height:1.7; font-size:18px; background:#f9f9f9; }
    .code-box { background:white; border:2px solid #3f6ff5; border-radius:16px; padding:32px; text-align:center; margin:24px 0; }
    /* Keep all 6 digits on one line, even on narrow mobile email clients */
    .code { font-size:48px; font-weight:700; letter-spacing:8px; color:#3f6ff5; font-family:monospace; white-space:nowrap; }
    @media (max-width: 420px) {
      .code-box { padding:22px; }
      .code { font-size:38px; letter-spacing:6px; }
    }
    .instructions { color:#44506b; margin:20px 0; font-size:16px; }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
    .warning { background:#fff8f0; padding:18px; border-radius:12px; margin:20px 0; border-left:4px solid #f59b45; color:#543210; font-size:15px; }
  `;

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Verify Your Email</h1>
            <p>Everane Registration</p>
          </div>
          <div class="content">
            <p>Thank you for registering with Everane! Please use the verification code below to complete your registration:</p>
            <div class="code-box">
              <div class="code">${code}</div>
            </div>
            <p class="instructions">Enter this code in the registration form to verify your email address.</p>
            <div class="warning">
              <strong>⚠️ Security Notice:</strong> This code will expire in 10 minutes. If you didn't request this code, please ignore this email.
            </div>
            <p>If you have any questions, please contact our support team.</p>
          </div>
          <div class="footer">
            This is an automated message from Everane.<br/>
            Please do not reply to this email.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
Verify Your Email - Everane Registration

Thank you for registering with Everane! Please use the verification code below to complete your registration:

${code}

Enter this code in the registration form to verify your email address.

⚠️ Security Notice: This code will expire in 10 minutes. If you didn't request this code, please ignore this email.

If you have any questions, please contact our support team.

---
This is an automated message from Everane.
Please do not reply to this email.
  `;

  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: email,
    subject: `Everane: Email Verification Code`,
    text: textBody,
    html: htmlBody
  };

  await transporter.sendMail(mailOptions);
  console.log(`Verification email sent to ${email}`);
}

/**
 * Helper function to send caregiver invitation email
 * @param {string} patientEmail - Patient's email address
 * @param {string} patientFirstName - Patient's first name
 * @param {string} caregiverName - Caregiver's name
 * @param {string} customMessage - Optional custom message from caregiver
 * @param {string} invitationId - Unique invitation ID for the custom link
 */
async function sendCaregiverInvitationEmail(patientEmail, patientFirstName, caregiverName, customMessage = null, invitationId) {
  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .content { padding:32px 28px; line-height:1.7; font-size:18px; background:#f9f9f9; }
    .message-box { background:white; border:2px solid #e5ecff; border-radius:16px; padding:24px; margin:24px 0; color:#1f2933; }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
  `;

  const messageBoxHtml = customMessage 
    ? `<div class="message-box"><strong>Message from ${caregiverName}:</strong><br><br>"${customMessage.replace(/"/g, '&quot;')}"</div>` 
    : '';

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Invitation to monitor medications on Everane</h1>
          </div>
          <div class="content">
            <p>Hello ${patientFirstName},</p>
            <p>${caregiverName} has invited you to share medication updates through Everane.</p>
            <p>If you accept, ${caregiverName} will be able to receive medication-related updates (such as adherence summaries or expiration alerts) based on the preferences you choose. Your medications cannot be changed by anyone else.</p>
            ${messageBoxHtml}
            <p>To review this request and decide whether to allow access, click the link below:</p>
            <p style="text-align: center; margin: 24px 0;">
              <a href="${APP_BASE_URL}/accept-caregiver.html?invitationId=${invitationId}" style="display: inline-block; padding: 14px 32px; background: #3f6ff5; color: white; text-decoration: none; border-radius: 14px; font-weight: 600;">👉 Review & Respond</a>
            </p>
            <p>You can decline or revoke access at any time. If you were not expecting this request, you may safely ignore this email.</p>
          </div>
          <div class="footer">
            Best regards,<br/>
            Everane<br/>
            <br/>
            Supporting safer, clearer medication management
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
Invitation to monitor medications on Everane

Hello ${patientFirstName},

${caregiverName} has invited you to share medication updates through Everane.

If you accept, ${caregiverName} will be able to receive medication-related updates (such as adherence summaries or expiration alerts) based on the preferences you choose. Your medications cannot be changed by anyone else.

${customMessage ? `Message from ${caregiverName}:\n\n"${customMessage}"\n\n` : ''}To review this request and decide whether to allow access, click the link below:

👉 Review & Respond: ${APP_BASE_URL}/accept-caregiver.html?invitationId=${invitationId}

You can decline or revoke access at any time. If you were not expecting this request, you may safely ignore this email.

Best regards,
Everane

Supporting safer, clearer medication management
  `;

  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: patientEmail,
    subject: `Invitation to monitor medications on Everane`,
    text: textBody,
    html: htmlBody
  };

  await transporter.sendMail(mailOptions);
  console.log(`Caregiver invitation email sent to ${patientEmail}`);
}

/**
 * Cloud Function to send caregiver invitation email
 * POST /sendCaregiverInvitation
 * Body: { patientEmail: string, caregiverId: string, caregiverName: string, customMessage?: string }
 */
exports.sendCaregiverInvitation = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { patientEmail, caregiverId, caregiverName, customMessage } = req.body;

    if (!patientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      res.status(400).json({ error: 'Valid patient email address is required' });
      return;
    }

    if (!caregiverId || !caregiverId.trim()) {
      res.status(400).json({ error: 'Caregiver ID is required' });
      return;
    }

    if (!caregiverName || !caregiverName.trim()) {
      res.status(400).json({ error: 'Caregiver name is required' });
      return;
    }

    // Find patient by email in Firestore
    const db = admin.firestore();
    const usersSnapshot = await db.collection('users')
      .where('email', '==', patientEmail.toLowerCase())
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      res.status(404).json({ error: 'User does not exist' });
      return;
    }

    const patientDoc = usersSnapshot.docs[0];
    const patientData = patientDoc.data();
    const patientName = patientData.name || 'User';
    const patientFirstName = patientName.split(' ')[0]; // Get first name

    // Generate unique invitation ID
    const invitationId = db.collection('invitations').doc().id;

    // Store invitation in Firestore
    await db.collection('invitations').doc(invitationId).set({
      caregiverId: caregiverId,
      caregiverName: caregiverName,
      patientEmail: patientEmail.toLowerCase(),
      patientName: patientName,
      customMessage: customMessage || null,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send email with invitation link
    await sendCaregiverInvitationEmail(patientEmail, patientFirstName, caregiverName, customMessage || null, invitationId);

    res.status(200).json({ 
      success: true, 
      message: 'Invitation email sent successfully'
    });

  } catch (error) {
    console.error('Error sending caregiver invitation email:', error);
    res.status(500).json({ error: 'Failed to send invitation email: ' + error.message });
  }
});

/**
 * Helper function to send caregiver acceptance confirmation email
 * @param {string} caregiverEmail - Caregiver's email address
 * @param {string} caregiverName - Caregiver's name
 * @param {string} patientName - Patient's name
 */
async function sendCaregiverAcceptanceEmail(caregiverEmail, caregiverName, patientName) {
  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#22c55e,#16a34a); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .content { padding:32px 28px; line-height:1.7; font-size:18px; background:#f9f9f9; }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
  `;

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Patient Accepted Your Invitation</h1>
          </div>
          <div class="content">
            <p>Hello ${caregiverName},</p>
            <p><strong>${patientName}</strong> has accepted your invitation and is now registered as a patient under your name!</p>
            <p>You can now receive medication-related updates for ${patientName} based on their preferences. You can manage your notification settings in your caregiver profile.</p>
            <p>Thank you for using Everane to help manage medications safely and effectively.</p>
          </div>
          <div class="footer">
            Best regards,<br/>
            Everane<br/>
            <br/>
            Supporting safer, clearer medication management
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
Patient Accepted Your Invitation - Everane

Hello ${caregiverName},

${patientName} has accepted your invitation and is now registered as a patient under your name!

You can now receive medication-related updates for ${patientName} based on their preferences. You can manage your notification settings in your caregiver profile.

Thank you for using Everane to help manage medications safely and effectively.

Best regards,
Everane

Supporting safer, clearer medication management
  `;

  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: caregiverEmail,
    subject: `${patientName} accepted your caregiver invitation`,
    text: textBody,
    html: htmlBody
  };

  await transporter.sendMail(mailOptions);
  console.log(`Caregiver acceptance email sent to ${caregiverEmail}`);
}

/**
 * Cloud Function to accept caregiver invitation and send confirmation email
 * POST /acceptCaregiverInvitation
 * Body: { invitationId: string, caregiverId: string, patientId: string, patientEmail: string, patientName: string }
 */
exports.acceptCaregiverInvitation = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { invitationId, caregiverId, patientId, patientEmail, patientName, idToken: bodyIdToken } = req.body;

    if (!invitationId || !caregiverId || !patientId || !patientEmail) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const db = admin.firestore();
    const patientEmailLower = patientEmail.toLowerCase();

    // --- AUTH CHECK (require patient to be signed in) ---
    const authHeader = req.headers.authorization || '';
    // Support both:
    //  - Authorization: Bearer <token> (preferred)
    //  - { idToken: "<token>" } in body (fallback for older clients / cached builds)
    const idToken =
      (authHeader.startsWith('Bearer ') ? authHeader.substring('Bearer '.length) : '') ||
      (typeof bodyIdToken === 'string' ? bodyIdToken : '');

    if (!idToken) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const decoded = await admin.auth().verifyIdToken(idToken);

    if (!decoded?.uid || decoded.uid !== patientId) {
      res.status(403).json({ error: 'Invalid user for this request' });
      return;
    }
    if (!decoded.email || decoded.email.toLowerCase() !== patientEmailLower) {
      res.status(403).json({ error: 'Email mismatch for this request' });
      return;
    }

    // --- INVITATION VALIDATION ---
    const invitationRef = db.collection('invitations').doc(invitationId);
    const invitationSnap = await invitationRef.get();
    if (!invitationSnap.exists) {
      res.status(404).json({ error: 'Invitation not found' });
      return;
    }
    const invitationData = invitationSnap.data() || {};
    if ((invitationData.patientEmail || '').toLowerCase() !== patientEmailLower) {
      res.status(403).json({ error: 'This invitation is not for your email' });
      return;
    }
    if ((invitationData.caregiverId || '') !== caregiverId) {
      res.status(400).json({ error: 'Caregiver mismatch for invitation' });
      return;
    }
    if (invitationData.status && invitationData.status !== 'pending') {
      res.status(409).json({ error: `Invitation already ${invitationData.status}` });
      return;
    }

    // 1) Add patient email + patientId to caregiver doc (server-side)
    const caregiverDocRef = db.collection('users').doc(caregiverId);
    await caregiverDocRef.set({
      patients: admin.firestore.FieldValue.arrayUnion(patientEmailLower),
      patientIds: admin.firestore.FieldValue.arrayUnion(patientId)
    }, { merge: true });

    // 2) Link patient -> caregiver (so caregiver can read patient data via rules)
    const patientDocRef = db.collection('users').doc(patientId);
    await patientDocRef.set({
      caregivers: admin.firestore.FieldValue.arrayUnion(caregiverId)
    }, { merge: true });

    // 3) Update invitation status
    await invitationRef.set({
      status: 'accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      patientId: patientId
    }, { merge: true });

    // 4) Email caregiver (best-effort)
    const caregiverSnap = await caregiverDocRef.get();
    const caregiverData = caregiverSnap.exists ? (caregiverSnap.data() || {}) : {};
    const caregiverEmail = caregiverData.email;
    const caregiverNameFinal = caregiverData.name || 'Caregiver';

    if (caregiverEmail) {
      await sendCaregiverAcceptanceEmail(caregiverEmail, caregiverNameFinal, patientName || invitationData.patientName || 'A patient');
    }

    res.status(200).json({ 
      success: true, 
      message: 'Invitation accepted successfully'
    });

  } catch (error) {
    console.error('Error accepting caregiver invitation:', error);
    res.status(500).json({ error: 'Failed to accept invitation: ' + error.message });
  }
});

/**
 * Cloud Function to sync caregiver<->patient links from caregiver's stored patient emails.
 * This is a repair path for older data where caregiver.users/{caregiverId}.patients existed
 * but patient.users/{patientId}.caregivers was not yet set (rules would block caregiver reads).
 *
 * POST /syncCaregiverPatients
 * Headers: Authorization: Bearer <Firebase ID token for caregiver>
 * Body: {}
 *
 * Returns: { patientIds: string[], linked: number, skipped: number }
 */
exports.syncCaregiverPatients = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const bodyIdToken = req.body?.idToken;
    const idToken =
      (authHeader.startsWith('Bearer ') ? authHeader.substring('Bearer '.length) : '') ||
      (typeof bodyIdToken === 'string' ? bodyIdToken : '');

    if (!idToken) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded?.uid) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const db = admin.firestore();
    const caregiverId = decoded.uid;

    const caregiverRef = db.collection('users').doc(caregiverId);
    const caregiverSnap = await caregiverRef.get();
    if (!caregiverSnap.exists) {
      res.status(404).json({ error: 'Caregiver profile not found' });
      return;
    }
    const caregiverData = caregiverSnap.data() || {};
    const patientEmails = Array.isArray(caregiverData.patients)
      ? caregiverData.patients.map(e => String(e || '').trim().toLowerCase()).filter(Boolean)
      : [];

    if (patientEmails.length === 0) {
      res.status(200).json({ patientIds: [], linked: 0, skipped: 0 });
      return;
    }

    const patientIds = [];
    let linked = 0;
    let skipped = 0;

    for (const email of patientEmails) {
      const qs = await db.collection('users').where('email', '==', email).limit(1).get();
      if (qs.empty) {
        skipped += 1;
        continue;
      }

      const patientDoc = qs.docs[0];
      const patientId = patientDoc.id;
      patientIds.push(patientId);

      // Link patient -> caregiver for rules-based read access
      await db.collection('users').doc(patientId).set({
        caregivers: admin.firestore.FieldValue.arrayUnion(caregiverId)
      }, { merge: true });

      linked += 1;
    }

    // Also store the fast path ids on caregiver doc
    if (patientIds.length > 0) {
      await caregiverRef.set({
        patientIds: admin.firestore.FieldValue.arrayUnion(...patientIds)
      }, { merge: true });
    }

    res.status(200).json({ patientIds, linked, skipped });
  } catch (error) {
    console.error('Error syncing caregiver patients:', error);
    res.status(500).json({ error: 'Failed to sync patients: ' + error.message });
  }
});

/**
 * =========================
 * Caregiver Email Reports (4 total)
 * =========================
 * These are the ONLY caregiver-email jobs we support:
 * 1) patient_expiration_dates  -> daily digest of patient bottle expirations (next 7 days)
 * 2) patient_weekly_reports    -> weekly digest (last 7 days adherence)
 * 3) patient_monthly_reports   -> monthly digest (last 30 days adherence)
 * 4) adherence_below_80        -> daily alert if any patient 7-day adherence < 80%
 *
 * IMPORTANT: This section is intentionally isolated to avoid impacting existing patient reminders.
 */

const CAREGIVER_EMAIL_KEYS = {
  PATIENT_EXPIRATION_DATES: 'patient_expiration_dates',
  PATIENT_WEEKLY_REPORTS: 'patient_weekly_reports',
  PATIENT_MONTHLY_REPORTS: 'patient_monthly_reports',
  ADHERENCE_BELOW_80: 'adherence_below_80',
  NEW_MEDICATION_ADDED: 'new_medication_added',
  NOTHING_RECORDED: 'nothing_recorded'
};

async function resolveCaregiverPatientIds(db, caregiverData) {
  const directIds = Array.isArray(caregiverData.patientIds)
    ? caregiverData.patientIds.map(String).filter(Boolean)
    : [];
  if (directIds.length > 0) return directIds;

  const emails = Array.isArray(caregiverData.patients)
    ? caregiverData.patients.map(e => String(e || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (emails.length === 0) return [];

  const ids = [];
  // Small N expected; keep it simple (admin privileges bypass rules).
  for (const email of emails) {
    const qs = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!qs.empty) ids.push(qs.docs[0].id);
  }
  return ids;
}

/**
 * Find all caregivers who opted in to receive reminders for a given patient.
 * Returns array of { email, phone, phoneVerified, prefs: { email: bool, sms: bool } }
 */
async function findCaregiverReminderRecipients(db, patientId) {
  const recipients = [];
  try {
    // Get the patient doc to find their caregivers array
    const patientSnap = await db.collection('users').doc(patientId).get();
    if (!patientSnap.exists) return recipients;
    const patientData = patientSnap.data() || {};
    const caregiverIds = Array.isArray(patientData.caregivers) ? patientData.caregivers : [];
    if (caregiverIds.length === 0) return recipients;

    for (const cid of caregiverIds) {
      try {
        const cSnap = await db.collection('users').doc(cid).get();
        if (!cSnap.exists) continue;
        const cData = cSnap.data() || {};
        const prefs = (cData.patientReminders || {})[patientId];
        if (!prefs || (!prefs.email && !prefs.sms && !prefs.push)) continue;
        recipients.push({
          uid: cid,
          email: (cData.email || '').toLowerCase(),
          phone: cData.phone || cData.phoneNumber || '',
          phoneVerified: !!cData.phoneVerified,
          name: cData.name || '',
          pushSubscriptions: Array.isArray(cData.pushSubscriptions) ? cData.pushSubscriptions : [],
          prefs
        });
      } catch (e) {
        console.warn(`[CaregiverReminders] Error loading caregiver ${cid}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[CaregiverReminders] Error finding caregiver recipients:', e.message);
  }
  return recipients;
}

/**
 * Forward medication reminders to opted-in caregivers.
 * Called after sending reminder to the patient.
 */
async function forwardRemindersToCaregiver(db, patientId, patientName, meds, reminderTime, offsetKey, userTimezone) {
  // SPEC v2: caregiver-forwarded reminders are EMAIL ONLY.
  // SMS and push forwarding to caregivers are intentionally disabled.
  try {
    const recipients = await findCaregiverReminderRecipients(db, patientId);
    if (recipients.length === 0) return;

    for (const r of recipients) {
      // Only fire email forward, and only if the caregiver opted in to email for this patient.
      if (r.prefs && r.prefs.email && r.email) {
        try {
          const medsCopy = meds.map(m => ({ ...m }));
          await sendCombinedReminderEmail(
            r.email, medsCopy, reminderTime, offsetKey,
            [], [], [], userTimezone,
            `[${patientName}] ` // subjectPrefix
          );
          console.log(`[CaregiverReminders] Forwarded email to caregiver ${r.email} for patient ${patientName}`);
        } catch (e) {
          console.warn(`[CaregiverReminders] Failed to email caregiver ${r.email}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[CaregiverReminders] Error forwarding reminders:', e.message);
  }
}

async function loadPatientProfile(db, patientId) {
  const snap = await db.collection('users').doc(patientId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    id: patientId,
    name: data.name || data.firstName || 'Patient',
    email: (data.email || '').toLowerCase(),
    timezone: data.timezone || DEFAULT_TIME_ZONE
  };
}

async function loadPatientMedications(db, patientId) {
  const snapshot = await db.collection('users').doc(patientId).collection('medications').get();
  return snapshot.docs.map(doc => {
    const raw = doc.data() || {};
    return {
      id: doc.id,
      name: raw.name || 'Medication',
      dosage: raw.dosage || '',
      daysOfWeek: raw.daysOfWeek || raw.days || [],
      times: Array.isArray(raw.times) ? raw.times.filter(Boolean) : [],
      timesPerDay: raw.timesPerDay || 0,
      startDate: raw.startDate || null,
      endDate: raw.endDate || null,
      deletedStatus: raw.deletedStatus === true,
      bottles: Array.isArray(raw.bottles) ? raw.bottles : [],
      stock: raw.stock || (Array.isArray(raw.bottles) ? raw.bottles.length : 0),
      doses: raw.doses || {}
    };
  });
}

function computeAdherenceForRange(meds, nowDateTime, days) {
  const start = nowDateTime.minus({ days: Math.max(0, days - 1) }).startOf('day');
  let total = 0;
  let taken = 0;
  let missed = 0;

  for (const med of meds) {
    for (let i = 0; i < days; i += 1) {
      const day = start.plus({ days: i });
      const dayIso = day.toISODate();

      if (!shouldSendReminderToday(med, day)) continue;

      const times = getReminderTimes(med);
      const dosesPerDay = Array.isArray(times) && times.length > 0 ? times.length : 1;

      for (let doseNumber = 1; doseNumber <= dosesPerDay; doseNumber += 1) {
        total += 1;
        const key = `${dayIso}_${doseNumber}`;
        const entry = med.doses ? med.doses[key] : null;

        if (entry && entry.taken === true) {
          taken += 1;
        } else {
          // Treat missing entries as missed (otherwise adherence is meaningless)
          missed += 1;
        }
      }
    }
  }

  const pct = total > 0 ? Math.round((taken / total) * 100) : null;
  return { taken, missed, total, pct };
}

async function sendCaregiverEmail(to, subject, htmlBody, textBody) {
  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to,
    subject,
    text: textBody,
    html: htmlBody
  };
  await transporter.sendMail(mailOptions);
}

async function sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody) {
  const caregiverEmail = caregiverData.email;
  if (caregiverEmail) {
    await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
  }
  // Also send SMS if caregiver has a verified phone
  const phone = caregiverData.phone || null;
  const phoneVerified = caregiverData.phoneVerified === true;
  if (phone && phoneVerified && smsBody && twilioClient && twilioFromNumber) {
    try {
      await sendSMS(phone, smsBody);
      console.log(`[Caregiver SMS] Sent to ${phone}`);
    } catch (err) {
      console.error(`[Caregiver SMS] Failed to send to ${phone}:`, err.message);
    }
  }
}

async function markCaregiverEmailSent(db, caregiverId, key) {
  const ref = db.collection('users').doc(caregiverId);
  const updateObj = { [`caregiverEmailState.${key}`]: admin.firestore.FieldValue.serverTimestamp() };
  try {
    await ref.update(updateObj);
  } catch (e) {
    // If the doc somehow doesn't exist yet, create it.
    await ref.set(updateObj, { merge: true });
  }
}

function caregiverAlreadySent(caregiverData, key) {
  return Boolean(caregiverData?.caregiverEmailState && caregiverData.caregiverEmailState[key]);
}

exports.sendCaregiverExpirationDatesEmails = functions.pubsub
  .schedule('0 9 * * *') // daily 09:00 UTC
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const todayKey = `expiration_${DateTime.utc().toISODate()}`;

    const caregiversSnap = await db.collection('users')
      .where('type', '==', 'C')
      .where('email_reminders', 'array-contains', CAREGIVER_EMAIL_KEYS.PATIENT_EXPIRATION_DATES)
      .get();

    for (const caregiverDoc of caregiversSnap.docs) {
      const caregiverId = caregiverDoc.id;
      const caregiverData = caregiverDoc.data() || {};

      if (caregiverAlreadySent(caregiverData, todayKey)) continue;
      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (patientIds.length === 0) continue;

      const linesText = [];
      const sectionsHtml = [];

      for (const patientId of patientIds) {
        const patient = await loadPatientProfile(db, patientId);
        if (!patient) continue;

        const patientNow = getNowInZone(patient.timezone);
        const bottleAlerts = await getBottleAlertsForUser(patientId, patientNow);
        if (!bottleAlerts || bottleAlerts.length === 0) continue;

        linesText.push(`${patient.name} (${patient.email || patientId})`);
        bottleAlerts.forEach(a => linesText.push(`- ${a.message}`));
        linesText.push('');

        const alertsHtml = bottleAlerts.map(a => `<li style="margin:6px 0;">${a.message}</li>`).join('');
        sectionsHtml.push(`
          <div style="padding:16px 16px; border:1px solid #d7e3ff; border-radius:16px; background:#ffffff; margin:14px 0;">
            <div style="font-size:18px; font-weight:800; color:#1f3c88;">${patient.name}</div>
            <div style="color:#64748b; margin-top:4px; font-size:14px;">${patient.email || ''}</div>
            <ul style="margin:12px 0 0; padding-left:18px; color:#0f172a; font-size:15px; line-height:1.5;">
              ${alertsHtml}
            </ul>
          </div>
        `);
      }

      if (sectionsHtml.length === 0) {
        // Nothing to send today
        continue;
      }

      const subject = 'Everane: Patient expiration alerts';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Patient expiration alerts</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">Bottles expiring within the next ${EXPIRATION_ALERT_DAYS} days</div>
            </div>
            <div style="padding:22px;">
              ${sectionsHtml.join('')}
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = [
        'Patient expiration alerts',
        `Bottles expiring within the next ${EXPIRATION_ALERT_DAYS} days`,
        '',
        ...linesText
      ].join('\n');

      // Stock / bottle / expiration alerts are email-only — no SMS for caregivers.
      await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, null);
      await markCaregiverEmailSent(db, caregiverId, todayKey);
      console.log(`[Caregiver] Sent expiration digest to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverAdherenceBelow80Alerts = functions.pubsub
  .schedule('30 9 * * *') // daily 09:30 UTC
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const todayKey = `adherenceBelow80_${DateTime.utc().toISODate()}`;

    const caregiversSnap = await db.collection('users')
      .where('type', '==', 'C')
      .where('email_reminders', 'array-contains', CAREGIVER_EMAIL_KEYS.ADHERENCE_BELOW_80)
      .get();

    for (const caregiverDoc of caregiversSnap.docs) {
      const caregiverId = caregiverDoc.id;
      const caregiverData = caregiverDoc.data() || {};

      if (caregiverAlreadySent(caregiverData, todayKey)) continue;
      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (patientIds.length === 0) continue;

      const linesText = [];
      const rowsHtml = [];

      for (const patientId of patientIds) {
        const patient = await loadPatientProfile(db, patientId);
        if (!patient) continue;

        const patientNow = getNowInZone(patient.timezone);
        const meds = await loadPatientMedications(db, patientId);
        const { pct, total, missed } = computeAdherenceForRange(meds, patientNow, 7);

        if (pct === null || total === 0) continue;
        if (pct >= 80) continue;

        linesText.push(`${patient.name} (${patient.email || patientId}) - 7d adherence: ${pct}% (missed ${missed}/${total})`);
        rowsHtml.push(`
          <tr>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${patient.name}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${pct}%</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${missed}/${total}</td>
          </tr>
        `);
      }

      if (rowsHtml.length === 0) continue;

      const subject = 'Everane: Adherence below 80%';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#ff6b6b,#ef4444); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Adherence below 80%</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">Last 7 days</div>
            </div>
            <div style="padding:22px;">
              <table style="width:100%; border-collapse:collapse; font-size:15px;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Patient</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Adherence</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Missed</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml.join('')}</tbody>
              </table>
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = ['Adherence below 80% (last 7 days)', '', ...linesText].join('\n');

      const smsBody = `Everane: Adherence below 80%\n${linesText.join('\n')}`;
      await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody);
      await markCaregiverEmailSent(db, caregiverId, todayKey);
      console.log(`[Caregiver] Sent adherence<80 alert to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverWeeklyReports = functions.pubsub
  .schedule('0 9 * * 1') // Mondays 09:00 UTC
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const weekKey = `weekly_${DateTime.utc().weekYear}-W${String(DateTime.utc().weekNumber).padStart(2, '0')}`;

    const caregiversSnap = await db.collection('users')
      .where('type', '==', 'C')
      .where('email_reminders', 'array-contains', CAREGIVER_EMAIL_KEYS.PATIENT_WEEKLY_REPORTS)
      .get();

    for (const caregiverDoc of caregiversSnap.docs) {
      const caregiverId = caregiverDoc.id;
      const caregiverData = caregiverDoc.data() || {};

      if (caregiverAlreadySent(caregiverData, weekKey)) continue;
      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (patientIds.length === 0) continue;

      const rowsHtml = [];
      const linesText = [];

      for (const patientId of patientIds) {
        const patient = await loadPatientProfile(db, patientId);
        if (!patient) continue;

        const patientNow = getNowInZone(patient.timezone);
        const meds = await loadPatientMedications(db, patientId);
        const { pct, total, missed } = computeAdherenceForRange(meds, patientNow, 7);

        if (pct === null || total === 0) continue;

        linesText.push(`${patient.name} - 7d adherence: ${pct}% (missed ${missed}/${total})`);
        rowsHtml.push(`
          <tr>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${patient.name}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${pct}%</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${missed}/${total}</td>
          </tr>
        `);
      }

      if (rowsHtml.length === 0) continue;

      const subject = 'Everane: Weekly patient report';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Weekly patient report</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">Last 7 days</div>
            </div>
            <div style="padding:22px;">
              <table style="width:100%; border-collapse:collapse; font-size:15px;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Patient</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Adherence</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Missed</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml.join('')}</tbody>
              </table>
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = ['Weekly patient report (last 7 days)', '', ...linesText].join('\n');

      const smsBody = `Everane: Weekly report\n${linesText.join('\n')}`;
      await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody);
      await markCaregiverEmailSent(db, caregiverId, weekKey);
      console.log(`[Caregiver] Sent weekly report to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverMonthlyReports = functions.pubsub
  .schedule('0 9 1 * *') // 1st of month 09:00 UTC
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const monthKey = `monthly_${DateTime.utc().toFormat('yyyy-MM')}`;

    const caregiversSnap = await db.collection('users')
      .where('type', '==', 'C')
      .where('email_reminders', 'array-contains', CAREGIVER_EMAIL_KEYS.PATIENT_MONTHLY_REPORTS)
      .get();

    for (const caregiverDoc of caregiversSnap.docs) {
      const caregiverId = caregiverDoc.id;
      const caregiverData = caregiverDoc.data() || {};

      if (caregiverAlreadySent(caregiverData, monthKey)) continue;
      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (patientIds.length === 0) continue;

      const rowsHtml = [];
      const linesText = [];

      for (const patientId of patientIds) {
        const patient = await loadPatientProfile(db, patientId);
        if (!patient) continue;

        const patientNow = getNowInZone(patient.timezone);
        const meds = await loadPatientMedications(db, patientId);
        const { pct, total, missed } = computeAdherenceForRange(meds, patientNow, 30);

        if (pct === null || total === 0) continue;

        linesText.push(`${patient.name} - 30d adherence: ${pct}% (missed ${missed}/${total})`);
        rowsHtml.push(`
          <tr>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${patient.name}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${pct}%</td>
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; color:#0f172a;">${missed}/${total}</td>
          </tr>
        `);
      }

      if (rowsHtml.length === 0) continue;

      const subject = 'Everane: Monthly patient report';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Monthly patient report</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">Last 30 days</div>
            </div>
            <div style="padding:22px;">
              <table style="width:100%; border-collapse:collapse; font-size:15px;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Patient</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Adherence</th>
                    <th align="left" style="padding:10px 12px; border-bottom:1px solid #d7e3ff; color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:.06em;">Missed</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml.join('')}</tbody>
              </table>
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = ['Monthly patient report (last 30 days)', '', ...linesText].join('\n');

      const smsBody = `Everane: Monthly report\n${linesText.join('\n')}`;
      await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody);
      await markCaregiverEmailSent(db, caregiverId, monthKey);
      console.log(`[Caregiver] Sent monthly report to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

// ============================================================
// CAREGIVER: New medication added (Firestore trigger)
// ============================================================
exports.onPatientMedicationCreated = functions.firestore
  .document('users/{userId}/medications/{medId}')
  .onCreate(async (snap, context) => {
    const db = admin.firestore();
    const patientId = context.params.userId;
    const medData = snap.data() || {};
    const medName = medData.name || 'a medication';

    // Skip deleted medications
    if (medData.deletedStatus === true) return null;

    // Find all caregivers who have this patient AND opted in to new_medication_added
    const patient = await loadPatientProfile(db, patientId);
    if (!patient) return null;

    // Find caregivers that list this patient
    const allCaregivers = await db.collection('users').where('type', '==', 'C').get();

    for (const caregiverDoc of allCaregivers.docs) {
      const caregiverData = caregiverDoc.data() || {};
      const reminders = Array.isArray(caregiverData.email_reminders) ? caregiverData.email_reminders : [];
      if (!reminders.includes(CAREGIVER_EMAIL_KEYS.NEW_MEDICATION_ADDED)) continue;

      // Check if this caregiver monitors this patient
      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (!patientIds.includes(patientId)) continue;

      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const subject = `Everane: ${patient.name} added a new medication`;
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">New medication added</div>
            </div>
            <div style="padding:22px;">
              <div style="padding:16px; border:1px solid #d7e3ff; border-radius:16px; background:#ffffff; margin:14px 0;">
                <div style="font-size:18px; font-weight:800; color:#1f3c88;">${patient.name}</div>
                <div style="color:#64748b; margin-top:4px; font-size:14px;">${patient.email || ''}</div>
                <div style="margin-top:12px; font-size:16px; color:#0f172a;">
                  Added: <strong>${medName}</strong>${medData.dosage ? ` (${medData.dosage})` : ''}
                </div>
              </div>
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = `${patient.name} added a new medication: ${medName}${medData.dosage ? ` (${medData.dosage})` : ''}`;
      const smsBody = `Everane: ${patient.name} added ${medName}${medData.dosage ? ` (${medData.dosage})` : ''}`;

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody);
        console.log(`[Caregiver] Sent new-med alert to ${caregiverEmail} for patient ${patientId}`);
      } catch (err) {
        console.error(`[Caregiver] Failed new-med alert to ${caregiverEmail}:`, err.message);
      }
    }

    return null;
  });

// ============================================================
// CAREGIVER: Nothing recorded today (daily check)
// ============================================================
exports.sendCaregiverNothingRecordedAlerts = functions.pubsub
  .schedule('0 21 * * *') // daily 21:00 UTC (afternoon/evening in most US timezones)
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const todayKey = `nothingRecorded_${DateTime.utc().toISODate()}`;

    const caregiversSnap = await db.collection('users')
      .where('type', '==', 'C')
      .where('email_reminders', 'array-contains', CAREGIVER_EMAIL_KEYS.NOTHING_RECORDED)
      .get();

    for (const caregiverDoc of caregiversSnap.docs) {
      const caregiverId = caregiverDoc.id;
      const caregiverData = caregiverDoc.data() || {};

      if (caregiverAlreadySent(caregiverData, todayKey)) continue;
      const caregiverEmail = caregiverData.email;
      if (!caregiverEmail) continue;

      const patientIds = await resolveCaregiverPatientIds(db, caregiverData);
      if (patientIds.length === 0) continue;

      const linesText = [];
      const sectionsHtml = [];

      for (const patientId of patientIds) {
        const patient = await loadPatientProfile(db, patientId);
        if (!patient) continue;

        const patientNow = getNowInZone(patient.timezone);
        const todayIso = patientNow.toISODate();
        const meds = await loadPatientMedications(db, patientId);
        const activeMeds = meds.filter(m => !m.deletedStatus);
        if (activeMeds.length === 0) continue;

        // Check if ANY dose was recorded today for this patient
        let anyRecorded = false;
        for (const med of activeMeds) {
          if (!shouldSendReminderToday(med, patientNow)) continue;
          const doses = med.doses || {};
          // Check all dose keys for today
          for (const key of Object.keys(doses)) {
            if (key.startsWith(todayIso + '_')) {
              anyRecorded = true;
              break;
            }
          }
          if (anyRecorded) break;
        }

        if (!anyRecorded) {
          linesText.push(`${patient.name} - No doses recorded today`);
          sectionsHtml.push(`
            <div style="padding:16px; border:1px solid #fecaca; border-radius:16px; background:#fff5f5; margin:14px 0;">
              <div style="font-size:18px; font-weight:800; color:#dc2626;">${patient.name}</div>
              <div style="color:#64748b; margin-top:4px; font-size:14px;">${patient.email || ''}</div>
              <div style="margin-top:8px; font-size:15px; color:#0f172a;">No doses recorded today.</div>
            </div>
          `);
        }
      }

      if (sectionsHtml.length === 0) continue; // All patients have recorded something

      const subject = 'Everane: Patients with nothing recorded today';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#ff6b6b,#ef4444); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Nothing recorded today</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">The following patients have no doses logged</div>
            </div>
            <div style="padding:22px;">
              ${sectionsHtml.join('')}
              <div style="margin-top:18px; color:#64748b; font-size:13px;">
                You can change these emails in your caregiver profile.
              </div>
            </div>
          </div>
        </div>
      `;
      const textBody = ['Nothing recorded today', '', ...linesText].join('\n');
      const smsBody = `Everane: Nothing recorded today\n${linesText.join('\n')}`;

      await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody, smsBody);
      await markCaregiverEmailSent(db, caregiverId, todayKey);
      console.log(`[Caregiver] Sent nothing-recorded alert to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

/**
 * Cloud Function to send caregiver acceptance confirmation email
 * POST /sendCaregiverAcceptanceEmail
 * Body: { caregiverId: string, caregiverEmail?: string, patientName: string, patientEmail: string }
 */
exports.sendCaregiverAcceptanceEmail = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { caregiverId, caregiverEmail, patientName, patientEmail } = req.body;

    if (!caregiverId || !patientName) {
      res.status(400).json({ error: 'Caregiver ID and patient name are required' });
      return;
    }

    const db = admin.firestore();

    // Get caregiver's email and name from Firestore if not provided
    let finalCaregiverEmail = caregiverEmail;
    let caregiverName = 'Caregiver';

    const caregiverDocRef = db.collection('users').doc(caregiverId);
    const caregiverDoc = await caregiverDocRef.get();

    if (caregiverDoc.exists) {
      const caregiverData = caregiverDoc.data();
      finalCaregiverEmail = finalCaregiverEmail || caregiverData.email;
      caregiverName = caregiverData.name || 'Caregiver';
    }

    if (!finalCaregiverEmail) {
      res.status(404).json({ error: 'Caregiver email not found' });
      return;
    }

    // Send email
    await sendCaregiverAcceptanceEmail(finalCaregiverEmail, caregiverName, patientName);

    res.status(200).json({ 
      success: true, 
      message: 'Acceptance email sent successfully'
    });

  } catch (error) {
    console.error('Error sending caregiver acceptance email:', error);
    res.status(500).json({ error: 'Failed to send acceptance email: ' + error.message });
  }
});

/**
 * Cloud Function to send email verification code
 * POST /sendEmailVerificationCode
 * Body: { email: string }
 */
exports.sendEmailVerificationCode = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Valid email address is required' });
      return;
    }

    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store code in Firestore with 10-minute expiration
    const db = admin.firestore();
    const verificationRef = db.collection('emailVerifications').doc();
    await verificationRef.set({
      email: email.toLowerCase(),
      code: code,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)) // 10 minutes
    });

    // Send email
    await sendEmailVerificationCode(email, code);

    res.status(200).json({ 
      success: true, 
      message: 'Verification email sent',
      // For testing only - remove in production
      code: code
    });

  } catch (error) {
    console.error('Error sending verification email:', error);
    res.status(500).json({ error: 'Failed to send verification email: ' + error.message });
  }
});

/**
 * Cloud Function to verify email code
 * POST /verifyEmailCode
 * Body: { email: string, code: string }
 */
exports.verifyEmailCode = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email, code } = req.body;

    if (!email || !code) {
      res.status(400).json({ error: 'Email and code are required' });
      return;
    }

    // Find verification record
    const db = admin.firestore();
    const verificationsSnapshot = await db.collection('emailVerifications')
      .where('email', '==', email.toLowerCase())
      .where('code', '==', code)
      .limit(1)
      .get();

    if (verificationsSnapshot.empty) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }

    const verification = verificationsSnapshot.docs[0].data();
    const expiresAt = verification.expiresAt.toDate();

    // Check if code has expired
    if (new Date() > expiresAt) {
      res.status(400).json({ error: 'Verification code has expired' });
      return;
    }

    // Mark as verified and delete the verification record
    await verificationsSnapshot.docs[0].ref.delete();

    res.status(200).json({ 
      success: true, 
      message: 'Email verified successfully' 
    });

  } catch (error) {
    console.error('Error verifying email code:', error);
    res.status(500).json({ error: 'Failed to verify code: ' + error.message });
  }
});

/**
 * Send phone verification code via Twilio SMS API
 * Generates a 6-digit OTP, stores in Firestore, sends via SMS
 */
exports.sendPhoneVerificationCode = functions.https.onRequest((req, res) => {
  console.log('🚀 FUNCTION CALLED - sendPhoneVerificationCode');
  console.log('  Method:', req.method);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { phoneNumber } = req.body;
      console.log('📱 sendPhoneVerificationCode called (Twilio SMS)');
      console.log('  Phone number:', phoneNumber);

      if (!phoneNumber) {
        res.status(400).json({ error: 'Phone number is required' });
        return;
      }

      if (!twilioClient || !twilioFromNumber) {
        console.error('❌ Twilio SMS client not initialized!');
        res.status(500).json({ error: 'SMS not configured' });
        return;
      }

      // Generate 6-digit OTP
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Store in Firestore
      const db = admin.firestore();
      await db.collection('phoneVerifications').doc(phoneNumber).set({
        code: code,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Send via Twilio SMS
      const message = `Your Everane verification code is: ${code}. It expires in 10 minutes.`;
      await sendSMS(phoneNumber, message);

      console.log('✅ Verification SMS sent successfully to', phoneNumber);
      res.status(200).json({
        success: true,
        message: 'Verification code sent via SMS'
      });

    } catch (error) {
      console.error('❌ Error sending phone verification code:', error);
      console.error('  Error message:', error.message);
      res.status(500).json({ error: 'Failed to send verification code: ' + error.message });
    }
  });
});

/**
 * Verify phone verification code and mark phone as verified in user profile
 */
exports.verifyPhoneCode = functions.https.onRequest((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { phoneNumber, code, userId } = req.body;

      if (!phoneNumber || !code) {
        res.status(400).json({ error: 'Phone number and code are required' });
        return;
      }

      console.log('🔐 verifyPhoneCode called');
      console.log('  Phone number:', phoneNumber);
      console.log('  User ID:', userId || 'not provided');

      const db = admin.firestore();
      const verDoc = await db.collection('phoneVerifications').doc(phoneNumber).get();

      if (!verDoc.exists) {
        res.status(400).json({ error: 'No verification code found. Please request a new one.' });
        return;
      }

      const verification = verDoc.data();
      const expiresAt = verification.expiresAt.toDate();

      // Check expiry
      if (new Date() > expiresAt) {
        await db.collection('phoneVerifications').doc(phoneNumber).delete();
        res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
        return;
      }

      // Check code
      if (verification.code !== code) {
        res.status(400).json({ error: 'Invalid verification code' });
        return;
      }

      // Code matches — clean up
      await db.collection('phoneVerifications').doc(phoneNumber).delete();
      console.log('✅ Phone verification code approved!');

      // If userId is provided, update Firestore to mark phone as verified
      if (userId) {
        await db.collection('users').doc(userId).set(
          { phoneVerified: true, phoneNumber: phoneNumber },
          { merge: true }
        );
        console.log(`  ✅ User ${userId} phone marked as verified in Firestore.`);
      }

      res.status(200).json({ message: 'Phone number verified successfully!', status: 'approved' });

    } catch (error) {
      console.error('❌ Error verifying phone code:', error);
      console.error('  Error message:', error.message);
      res.status(500).json({ error: 'Failed to verify code: ' + error.message });
    }
  });
});

/**
 * Cloud Function to handle contact form submissions
 * POST /sendContactForm
 * Body: { name: string, email: string, message: string }
 */
exports.sendContactForm = functions.https.onRequest((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { name, email, message } = req.body;

      // Validate required fields
      if (!name || !email || !message) {
        res.status(400).json({ error: 'Name, email, and message are all required' });
        return;
      }

      // Validate email format
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'A valid email address is required' });
        return;
      }

      // Build professional HTML email body
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #4A90D9; color: #ffffff; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">Everane Contact Form</h1>
          </div>
          <div style="background-color: #ffffff; border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
            <p style="color: #333333; font-size: 16px; margin-top: 0;">You have received a new message from the Everane contact form.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
              <tr>
                <td style="padding: 10px 12px; font-weight: bold; color: #555555; border-bottom: 1px solid #eeeeee; width: 100px;">Name</td>
                <td style="padding: 10px 12px; color: #333333; border-bottom: 1px solid #eeeeee;">${name}</td>
              </tr>
              <tr>
                <td style="padding: 10px 12px; font-weight: bold; color: #555555; border-bottom: 1px solid #eeeeee;">Email</td>
                <td style="padding: 10px 12px; color: #333333; border-bottom: 1px solid #eeeeee;"><a href="mailto:${email}" style="color: #4A90D9;">${email}</a></td>
              </tr>
            </table>
            <div style="margin-top: 20px;">
              <h3 style="color: #555555; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Message</h3>
              <div style="background-color: #f9f9f9; border-left: 4px solid #4A90D9; padding: 16px; border-radius: 4px; color: #333333; line-height: 1.6; white-space: pre-wrap;">${message}</div>
            </div>
            <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;" />
            <p style="color: #999999; font-size: 12px; text-align: center; margin-bottom: 0;">This email was sent from the Everane contact form. Reply directly to respond to the sender.</p>
          </div>
        </div>
      `;

      // Send email via nodemailer transporter
      const mailOptions = {
        from: gmailEmail,
        replyTo: email,
        to: 'rishikeshalladi@gmail.com',
        subject: `[Everane Contact] Message from ${name}`,
        html: htmlBody
      };

      await transporter.sendMail(mailOptions);
      console.log(`✅ Contact form email sent from ${name} (${email})`);

      res.status(200).json({ success: true });

    } catch (error) {
      console.error('❌ Error sending contact form email:', error);
      res.status(500).json({ error: 'Failed to send contact form message: ' + error.message });
    }
  });
});

/**
 * createRealtimeSession
 * Creates an ephemeral OpenAI Realtime session and returns the client_secret.
 * The client uses this secret to connect directly to OpenAI via WebRTC.
 */
exports.createRealtimeSession = functions.https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      // Verify Firebase auth token
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) {
        res.status(401).json({ error: 'Missing auth token' });
        return;
      }

      await admin.auth().verifyIdToken(idToken);

      // Get OpenAI API key from functions config
      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) {
        res.status(500).json({ error: 'OpenAI API key not configured' });
        return;
      }

      // Create ephemeral Realtime client secret with instructions + tools baked in.
      // This guarantees instructions are applied BEFORE the client connects (no race condition).
      const sessionResp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: 'gpt-realtime',
            instructions: 'You are a medication data collector for Everane. You collect 6 fields one at a time through conversation.\n\nCRITICAL RULE: Each response must contain ONLY ONE short question or acknowledgment. Never ask multiple questions. Never give medical facts, advice, drug information, or commentary. Never mention side effects or drug interactions.\n\nThe 6 fields to collect in order:\n- name: medication name\n- dosage: e.g. "2 pills", "1 tablet", "500 mg". Accept the first answer. Never ask follow-ups about strength or milligrams.\n- schedule: days and times. If they say morning/evening, ask for exact time. Ask if they want to add another schedule.\n- startDate: convert to YYYY-MM-DD, default year 2026\n- endDate: YYYY-MM-DD or null if ongoing\n- reminderChannels: How the user wants to be reminded. Ask exactly: "How would you like to be reminded? You can pick email, text message, push notifications, or any combination — or say none." Accept MULTIPLE channels in a single answer (e.g. "email and text"). Valid values are any subset of ["email","sms","push"]. Map "text", "text message", or "texts" to "sms". An empty array means no reminders. If the user picks sms, do not ask for their phone number — they enter it in their profile.\n\nStart by asking for the medication name. After the user answers each question, acknowledge briefly and ask the next one. After collecting all 6, say "All set!" and call submit_medication_draft immediately. Do not recap or summarize.\n\nIf the user asks a follow-up question, asks you to repeat something, or asks for clarification, answer it briefly and then continue collecting the next field.\n\nCRITICAL — ANTI-ASSUMPTION RULES (MUST FOLLOW):\n1. NEVER move to the next question until the user has given a clear, audible verbal answer to the current question.\n2. If you hear silence, background noise, or anything unclear, say "Sorry, I didn\'t catch that. Could you repeat your answer?" Do NOT treat silence as an answer.\n3. NEVER guess, assume, or fill in ANY field on your own. Every single field value must come directly from the user\'s spoken words.\n4. If the user\'s response is ambiguous or partial, ask a clarifying follow-up before moving on.\n5. Do NOT skip ahead. Do NOT bundle questions. Ask exactly one question, then STOP and WAIT.\n6. If you are unsure whether the user answered, ask again. It is always better to re-ask than to assume.\n7. NEVER auto-advance to the next field based on context clues, previous answers, or common defaults.',
            tools: [{
              type: 'function',
              name: 'submit_medication_draft',
              description: 'Submit the completed medication draft with schedule array.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', description: 'Medication name' },
                  dosage: { type: 'string', description: 'Dosage as spoken, e.g. 2 pills, 1 tablet' },
                  schedule: {
                    type: 'array',
                    description: 'Array of schedule entries.',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['weekly', 'interval'] },
                        days: { type: 'array', items: { type: 'string' }, description: 'Day names for weekly' },
                        times: { type: 'array', items: { type: 'string' }, description: 'HH:MM 24h format' },
                        every: { type: 'number', description: 'Interval value' },
                        unit: { type: 'string', enum: ['hours', 'days', 'weeks'] },
                      },
                      required: ['type', 'times'],
                    },
                  },
                  startDate: { type: 'string', description: 'YYYY-MM-DD' },
                  endDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  reminderChannels: {
                    type: 'array',
                    description: 'Selected reminder channels. Any combination of email, sms, push. Empty array means none. Map spoken words "text" / "text message" / "texts" to "sms".',
                    items: { type: 'string', enum: ['email', 'sms', 'push'] }
                  },
                },
                required: ['name', 'dosage', 'schedule', 'startDate', 'endDate', 'reminderChannels'],
              },
            }],
            tool_choice: 'auto',
          },
        }),
      });

      if (!sessionResp.ok) {
        const errText = await sessionResp.text().catch(() => '');
        console.error('OpenAI client_secrets error:', sessionResp.status, errText.slice(0, 500));
        res.status(502).json({ error: `OpenAI returned ${sessionResp.status}`, details: errText.slice(0, 300) });
        return;
      }

      const sessionData = await sessionResp.json();
      // GA response shape: { value: "ek_...", expires_at: ..., session: { id, model, ... } }
      const clientSecret = sessionData.value
        || sessionData.client_secret?.value
        || sessionData.client_secret;

      if (!clientSecret) {
        console.error('❌ Could not extract client_secret from response:', JSON.stringify(sessionData).slice(0, 500));
        res.status(500).json({ error: 'Could not extract client_secret from OpenAI response' });
        return;
      }

      console.log('✅ Created Realtime client secret for session:', sessionData.session?.id || 'unknown');

      res.status(200).json({
        client_secret: clientSecret,
        session_id: sessionData.session?.id,
      });

    } catch (error) {
      console.error('❌ createRealtimeSession error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

/**
 * transcribeAudio
 * Receives base64-encoded audio, sends to OpenAI transcription API, returns transcript text.
 */
exports.transcribeAudio = functions.https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
      await admin.auth().verifyIdToken(idToken);

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      const { audio, mimeType } = req.body || {};
      if (!audio) { res.status(400).json({ error: 'Missing audio data' }); return; }

      const audioBuffer = Buffer.from(audio, 'base64');
      const contentType = mimeType || 'audio/webm';
      const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mp4') ? 'mp4' : 'webm';

      // Build multipart boundary manually — most reliable in all Node 20 environments
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const CRLF = '\r\n';
      const parts = [];
      // File part
      parts.push(`--${boundary}${CRLF}`);
      parts.push(`Content-Disposition: form-data; name="file"; filename="recording.${ext}"${CRLF}`);
      parts.push(`Content-Type: ${contentType}${CRLF}${CRLF}`);
      const headerBuf = Buffer.from(parts.join(''));
      const footerParts = [];
      footerParts.push(`${CRLF}--${boundary}${CRLF}`);
      footerParts.push(`Content-Disposition: form-data; name="model"${CRLF}${CRLF}gpt-4o-mini-transcribe`);
      footerParts.push(`${CRLF}--${boundary}${CRLF}`);
      footerParts.push(`Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json`);
      footerParts.push(`${CRLF}--${boundary}--${CRLF}`);
      const footerBuf = Buffer.from(footerParts.join(''));
      const multipartBody = Buffer.concat([headerBuf, audioBuffer, footerBuf]);

      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error('OpenAI transcription error:', resp.status, errText.slice(0, 500));
        res.status(502).json({ error: `OpenAI returned ${resp.status}`, details: errText.slice(0, 300) });
        return;
      }

      const data = await resp.json();
      console.log('Transcription:', (data.text || '').slice(0, 100));
      res.status(200).json({ text: data.text || '' });
    } catch (error) {
      console.error('transcribeAudio error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

/**
 * lookupMedicationImage
 * Given a free-typed medication name, validates it via OpenAI (gpt-4o-mini) and,
 * if it's recognized, returns a product image URL via Serper.dev Image Search.
 * Results are cached in Firestore at /medicationImageCache/{normalizedKey} for
 * 30 days to keep API costs low and latency snappy.
 *
 * Request body: { name: "metforminn" }
 * Response: {
 *   isMed: boolean,
 *   canonical: "Metformin"  | null,
 *   genericName: "Metformin" | null,
 *   form: "tablet"|"capsule"|"liquid"|"injection"|"patch"|"inhaler"|"cream"|"other" | null,
 *   imageUrl: "https://..." | null,
 *   source: "cache"|"fresh"|"none",
 *   cachedAt: ISO string | null
 * }
 */
const MED_IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MED_IMAGE_HOST_BLOCKLIST = new Set([
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
  'twitter.com', 'twimg.com', 'pinimg.com', 'pinterest.com',
  'tiktok.com', 'tiktokcdn.com', 'youtube.com', 'ytimg.com',
  'reddit.com', 'redd.it', 'imgur.com',
  'lookaside.fbsbx.com',
]);

// Bump this whenever the Serper search query OR LLM output shape changes (so
// existing cache entries for old shapes are bypassed and re-fetched cleanly).
const MED_IMAGE_CACHE_VERSION = 'v3-bottle-summary';

function normalizeMedKey(raw) {
  const base = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
  return base ? `${base}__${MED_IMAGE_CACHE_VERSION}` : '';
}

function isAllowedImageHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^www\./, '');
    for (const blocked of MED_IMAGE_HOST_BLOCKLIST) {
      if (host === blocked || host.endsWith('.' + blocked)) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

exports.lookupMedicationImage = functions.runWith({ timeoutSeconds: 20 }).https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      // Auth (signed-in users only — keeps the API key + cache private).
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
      try { await admin.auth().verifyIdToken(idToken); }
      catch (e) { res.status(401).json({ error: 'Invalid auth token' }); return; }

      const rawName = (req.body && req.body.name) || '';
      const key = normalizeMedKey(rawName);
      if (!key || key.length < 2) {
        res.status(200).json({ isMed: false, canonical: null, genericName: null, form: null, imageUrl: null, source: 'none', cachedAt: null });
        return;
      }
      if (key.length > 80) {
        res.status(400).json({ error: 'Name too long' });
        return;
      }

      const db = admin.firestore();
      const cacheRef = db.collection('medicationImageCache').doc(key);

      // 1. Cache check
      try {
        const cacheSnap = await cacheRef.get();
        if (cacheSnap.exists) {
          const c = cacheSnap.data() || {};
          const fetchedAtMs = (c.fetchedAt && c.fetchedAt.toMillis) ? c.fetchedAt.toMillis() : 0;
          const ageMs = Date.now() - fetchedAtMs;
          if (fetchedAtMs > 0 && ageMs < MED_IMAGE_CACHE_TTL_MS) {
            // Best-effort hit counter (don't await)
            cacheRef.update({ hitCount: admin.firestore.FieldValue.increment(1), lastHitAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
            res.status(200).json({
              isMed: !!c.isMed,
              canonical: c.canonical || null,
              genericName: c.genericName || null,
              form: c.form || null,
              summary: c.summary || null,
              imageUrl: c.imageUrl || null,
              source: 'cache',
              cachedAt: new Date(fetchedAtMs).toISOString(),
            });
            return;
          }
        }
      } catch (e) {
        console.warn('[lookupMedicationImage] cache read failed:', e.message);
      }

      // 2. OpenAI validator
      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      let validator = { isMed: false, canonical: null, genericName: null, form: null, summary: null };
      try {
        const sys = "You are a strict medication name validator and brief information writer. The user types a free-form string. Decide if it's a real prescription drug, a recognized OTC medication (e.g. ibuprofen, acetaminophen, loratadine, melatonin, aspirin), or a recognized supplement/vitamin used in daily reminder schedules (e.g. Vitamin D, Vitamin B12, Fish Oil, Iron, Magnesium). Reject pure non-medical words, foods, brand jokes, or random text. Tolerate common misspellings (e.g. 'metforminn' -> 'Metformin').\n\nRespond with STRICT JSON only, no prose. Schema: { \"isMed\": boolean, \"canonical\": string|null, \"genericName\": string|null, \"form\": \"tablet\"|\"capsule\"|\"liquid\"|\"injection\"|\"patch\"|\"inhaler\"|\"cream\"|\"other\"|null, \"summary\": string|null }.\n\nRules:\n- canonical: canonical capitalization (e.g. 'Metformin', 'Vitamin D').\n- genericName: active ingredient if the user typed a brand (e.g. 'Lipitor' -> 'Atorvastatin'). Otherwise null.\n- summary: when isMed is true, write 2–3 short, plain-English sentences (35–60 words total) describing what the medication is and what it's commonly used for. Be factual and neutral. Do NOT include dosing instructions, do NOT give medical advice, do NOT list specific side effects, do NOT mention drug interactions. Mention the drug class if helpful (e.g. 'Metformin is a biguanide used to manage type 2 diabetes...'). End with a complete sentence. When isMed is false, set summary to null.\n- If isMed is false, set every other field to null.";
        const llmResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 250,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: rawName.slice(0, 80) },
            ],
          }),
        });
        if (!llmResp.ok) {
          const t = await llmResp.text().catch(() => '');
          console.warn('[lookupMedicationImage] OpenAI returned', llmResp.status, t.slice(0, 200));
        } else {
          const llmData = await llmResp.json();
          const raw = llmData?.choices?.[0]?.message?.content || '{}';
          try {
            const parsed = JSON.parse(raw);
            validator.isMed = parsed.isMed === true;
            validator.canonical = typeof parsed.canonical === 'string' ? parsed.canonical.trim() : null;
            validator.genericName = typeof parsed.genericName === 'string' ? parsed.genericName.trim() : null;
            const formAllowed = new Set(['tablet','capsule','liquid','injection','patch','inhaler','cream','other']);
            validator.form = formAllowed.has(parsed.form) ? parsed.form : null;
            if (typeof parsed.summary === 'string') {
              const s = parsed.summary.trim();
              // Cap at ~500 chars defensively; the prompt asks for ~60 words.
              validator.summary = s.length > 500 ? s.slice(0, 500) : s;
            }
          } catch (e) {
            console.warn('[lookupMedicationImage] LLM JSON parse failed:', e.message, raw.slice(0, 200));
          }
        }
      } catch (e) {
        console.warn('[lookupMedicationImage] OpenAI call failed:', e.message);
      }

      // If not a med, cache the rejection and return.
      if (!validator.isMed || !validator.canonical) {
        try {
          await cacheRef.set({
            isMed: false, canonical: null, genericName: null, form: null,
            imageUrl: null, source: 'none',
            fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
            hitCount: 0,
          });
        } catch (_) {}
        res.status(200).json({
          isMed: false, canonical: null, genericName: null, form: null,
          imageUrl: null, source: 'fresh', cachedAt: new Date().toISOString(),
        });
        return;
      }

      // 3. Serper image search
      const serperKey = functions.config().serper?.api_key;
      let imageUrl = null;
      if (serperKey) {
        try {
          // Search for the medication BOTTLE (not loose pills) so users can match
          // what's actually sitting in their cabinet. The validator's `form` is
          // intentionally NOT used here — bottle photography is consistent
          // regardless of pill/capsule/liquid format.
          const q = `${validator.canonical} prescription bottle`;
          const srResp = await fetch('https://google.serper.dev/images', {
            method: 'POST',
            headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, num: 8, gl: 'us', hl: 'en' }),
          });
          if (srResp.ok) {
            const srData = await srResp.json();
            const candidates = Array.isArray(srData.images) ? srData.images : [];
            for (const cand of candidates) {
              const u = cand.imageUrl || cand.thumbnailUrl;
              if (!u) continue;
              if (!isAllowedImageHost(u)) continue;
              const w = Number(cand.imageWidth || 0);
              const h = Number(cand.imageHeight || 0);
              if (w && h && (w < 150 || h < 150)) continue;
              imageUrl = u;
              break;
            }
          } else {
            const t = await srResp.text().catch(() => '');
            console.warn('[lookupMedicationImage] Serper returned', srResp.status, t.slice(0, 200));
          }
        } catch (e) {
          console.warn('[lookupMedicationImage] Serper call failed:', e.message);
        }
      } else {
        console.warn('[lookupMedicationImage] Serper API key not configured');
      }

      // 4. Cache + respond
      try {
        await cacheRef.set({
          isMed: true,
          canonical: validator.canonical,
          genericName: validator.genericName,
          form: validator.form,
          summary: validator.summary,
          imageUrl: imageUrl,
          source: 'serper',
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
          hitCount: 0,
        });
      } catch (e) {
        console.warn('[lookupMedicationImage] cache write failed:', e.message);
      }

      res.status(200).json({
        isMed: true,
        canonical: validator.canonical,
        genericName: validator.genericName,
        form: validator.form,
        summary: validator.summary,
        imageUrl: imageUrl,
        source: 'fresh',
        cachedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[lookupMedicationImage] error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

/**
 * extractMedicationFromImages
 * Accepts 1–5 base64-encoded images of pill bottles, Rx labels, doctor notes,
 * or pharmacy printouts. Calls OpenAI gpt-4o-mini Vision to extract a unified
 * structured medication record. Returns the extracted fields PLUS a per-field
 * confidence map so the frontend can highlight uncertain fields in yellow.
 *
 * Returns:
 * {
 *   name: string|null,
 *   genericName: string|null,
 *   dosage: string|null,            // free-form display string ("500 mg", "1 tablet")
 *   dosageQuantity: number|null,    // numeric pills-per-dose (mapped to form field)
 *   schedules: Array|null,          // [{type, days, times, every, unit}] in Everane shape
 *   startDate: "YYYY-MM-DD"|null,
 *   endDate: "YYYY-MM-DD"|null,
 *   bottles: Array|null,            // [{expiration:"MM/DD/YYYY", quantity:number}]
 *   notes: string|null,             // anything noteworthy (prescriber, pharmacy, etc.)
 *   confidence: { fieldName: number 0..1 },
 *   ambiguities: string[],          // human-readable warnings for the UI
 *   imageCount: number
 * }
 *
 * Notification preferences (reminderChannels) are NEVER extracted from images —
 * the user always picks those manually.
 */
exports.extractMedicationFromImages = functions.runWith({ timeoutSeconds: 60, memory: '512MB' }).https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      // Auth
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
      try { await admin.auth().verifyIdToken(idToken); }
      catch (e) { res.status(401).json({ error: 'Invalid auth token' }); return; }

      // Validate images
      const images = Array.isArray(req.body && req.body.images) ? req.body.images : [];
      if (images.length === 0) { res.status(400).json({ error: 'No images provided' }); return; }
      if (images.length > 5) { res.status(400).json({ error: 'Maximum 5 images per extraction' }); return; }
      for (const img of images) {
        if (typeof img !== 'string') { res.status(400).json({ error: 'Each image must be a base64 data URI string' }); return; }
        if (!img.startsWith('data:image/')) { res.status(400).json({ error: 'Each image must be a base64 image data URI (data:image/...)' }); return; }
        // ~7 MB cap per image (post-base64 padding). Real client-side resize keeps these well under 500 KB.
        if (img.length > 7 * 1024 * 1024 * 4 / 3) { res.status(400).json({ error: 'One or more images exceed the 7 MB limit' }); return; }
      }

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      const today = DateTime.utc().toISODate();
      const systemPrompt = [
        "You are a medication extraction assistant. The user uploads 1 or more images that may be:",
        "- Prescription bottle labels (most common)",
        "- Pharmacy printouts / Rx slips / discharge summaries / emails",
        "- Handwritten doctor notes or hand-written instructions from the user",
        "- Combination shots (front + back of same bottle, bottle + note, etc.)",
        "",
        "Read every image. They describe ONE medication. Extract a single unified record.",
        "",
        "Respond with STRICT JSON only, no prose. Schema:",
        "{",
        '  "name": string|null,           // canonical brand or generic name (e.g. "Metformin", "Lipitor", "Vitamin D")',
        '  "genericName": string|null,    // generic / active ingredient if the user typed a brand (e.g. brand "Lipitor" -> "Atorvastatin")',
        '  "dosage": string|null,         // human display string ("500 mg", "1 tablet", "10 mg/5 mL")',
        '  "dosageQuantity": number|null, // numeric pills/units per dose (e.g. "Take 2 tablets" -> 2). Integer if possible.',
        '  "schedules": [                 // array of schedule entries in Everane shape',
        '    {',
        '      "type": "weekly"|"interval",',
        '      "days": ["monday","tuesday",...] | null,  // weekly only; lowercase full names',
        '      "times": ["HH:MM",...] | null,            // 24h, zero-padded; one entry per dose at that schedule',
        '      "every": number | null,                   // interval only',
        '      "unit": "hours"|"days"|"weeks" | null     // interval only',
        '    }',
        '  ] | null,',
        '  "startDate": "YYYY-MM-DD"|null,   // first day of the prescription if visible OR computable',
        '  "endDate": "YYYY-MM-DD"|null,     // last day if visible OR computable from a duration phrase',
        '  "bottles": [                       // bottles found in the image(s)',
        '    { "expiration": "MM/DD/YYYY"|null, "quantity": number|null }',
        '  ] | null,',
        '  "notes": string|null,              // pharmacy name, prescriber, Rx number — anything useful',
        '  "confidence": { "name": 0..1, "dosage": 0..1, "schedules": 0..1, "startDate": 0..1, "endDate": 0..1, "bottles": 0..1, "dosageQuantity": 0..1 },',
        '  "ambiguities": [string],           // human-readable warnings the UI should surface',
        '  "extractedFrom": {                 // for each populated field, where the value came from. Used by the UI to show e.g. "from your note".',
        '     "name": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "dosage": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "dosageQuantity": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "schedules": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "startDate": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "endDate": "bottle"|"note"|"printout"|"mixed"|null,',
        '     "bottles": "bottle"|"note"|"printout"|"mixed"|null',
        '  }',
        "}",
        "",
        "═══ CORE RULE ═══",
        "Do NOT assume anything. If a value is not explicitly stated or directly derivable, the field is null. Lower confidence and add an ambiguity rather than inventing.",
        "",
        "═══ SOURCE TRUST HIERARCHY ═══",
        "When images conflict (e.g. bottle label says 'twice daily' but a handwritten note says 'three times daily'):",
        "- For SCHEDULE, dosageQuantity, dosage, startDate, endDate: HANDWRITTEN NOTES and PRINTOUTS/EMAILS override printed bottle labels. The most recent / most explicit instruction wins. Reasoning: bottles are filled at one point in time, but a note from the user or doctor reflects the CURRENT plan.",
        "- For name, strength (mg), and bottle expiration / quantity: PRINTED BOTTLE LABELS win over notes. Notes commonly use shortened names; bottles have the official spelling and exact strength.",
        "- When values agree across sources, use them and mark extractedFrom='mixed' with high confidence.",
        "- Set extractedFrom.<field> = 'bottle' | 'note' | 'printout' | 'mixed' for every populated field so the UI can label its origin.",
        "",
        "═══ FIELD-SPECIFIC RULES ═══",
        "",
        "1. The `reminderChannels` field is NEVER part of this output — the user picks it manually. Do not invent it.",
        "",
        "2. Confidence scores 0..1:",
        "   - 1.0  = crisp and unambiguous",
        "   - 0.7  = mild ambiguity (faded ink, partial occlusion)",
        "   - <0.5 = significant doubt; PREFER to set the field to null instead",
        "",
        "3. Schedules:",
        "   a. Map natural-language phrases to the schema:",
        "      - 'Take 1 tablet twice daily' (no specific times) -> single weekly entry, days=[all 7], times=null (UNKNOWN), dosageQuantity=1, ambiguity='Twice daily — please pick times'.",
        "      - 'Take 1 tablet by mouth daily in the morning' -> days=[all 7], times=['08:00'], confidence.schedules=0.75.",
        "      - 'Every Monday at 8 AM' -> [{type:weekly, days:['monday'], times:['08:00']}].",
        "      - 'Every 8 hours' -> [{type:interval, every:8, unit:'hours', times:null}], confidence.schedules=0.5, ambiguities=['Start time of the 8-hour cycle unclear — please set it'].",
        "      - 'Take with food morning and night' -> two times, ['08:00','20:00'], schedules.confidence=0.6, ambiguity='Approximate times — please verify'.",
        "   b. Days array uses LOWERCASE full names: 'monday','tuesday','wednesday','thursday','friday','saturday','sunday'.",
        "   c. Times are 24-hour zero-padded: '08:00', '14:30', '21:00'.",
        "   d. IMPORTANT — AM/PM:",
        "      - If a time is stated WITHOUT an AM/PM marker AND without other context that disambiguates (e.g. 'in the morning', 'at bedtime', 'with breakfast'), DO NOT GUESS. Set times=null for that schedule and add an ambiguity 'Time \"8\" given without AM/PM — please pick the exact time'.",
        "      - Only convert to a 24h time when AM/PM is explicit OR the context is unmistakable.",
        `4. Dates: today is ${today}.`,
        "   a. startDate: use the explicit fill date / start date from the label or note if visible. Otherwise null.",
        "   b. endDate: COMPUTE from a duration phrase when present. Examples:",
        `      - 'every day for 4 weeks at 4 pm' (today is ${today}) -> endDate = today + 28 days, return as YYYY-MM-DD.`,
        "      - 'take for 10 days starting 2026-04-01' -> endDate = 2026-04-10.",
        "      - 'until 1/15/2027' -> endDate = 2027-01-15.",
        "      - 'discontinue after the bottle is empty' -> endDate=null, ambiguity='End date depends on bottle finish — please set manually'.",
        "      - No duration phrase ANYWHERE in any image -> endDate=null.",
        "      Confidence reflects how clear the duration was.",
        "",
        "5. Dosage:",
        "   - dosage = human display ('500 mg', '1 tablet', '10 mg/5 mL').",
        "   - dosageQuantity = INTEGER pills-per-dose. ONLY populate if the source(s) explicitly say how many to take per dose. If the label only states a strength (e.g. '500 mg') with NO take-N-tablets instruction, leave dosageQuantity=null. Do NOT default to 1.",
        "",
        "6. Bottles array: include one entry per physical bottle visible. expiration in MM/DD/YYYY. quantity is the pill count (e.g. '#30' -> 30). If a bottle is visible but the expiration is not legible, set expiration=null AND set extractedFrom.bottles='bottle' AND lower confidence.bottles AND add ambiguity 'Bottle expiration not visible — please enter it manually'.",
        "",
        "7. Output JSON ONLY. No markdown fences. No prose. No commentary.",
        "",
        "8. If you can extract NOTHING at all (illegible / not a medication image), return all fields null, confidence={}, extractedFrom={}, and ambiguities=['Could not read medication information from the image(s) provided'].",
        "",
        "9. NEVER include personally-identifying info like patient name in the `notes` field. Pharmacy name and prescriber name are OK; patient name is NOT.",
      ].join('\n');

      // Build vision message
      const userContent = [
        { type: 'text', text: `Extract a single unified medication record from the following ${images.length} image(s).` },
        ...images.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'high' } })),
      ];

      let parsed = null;
      try {
        const llmResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 1200,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
          }),
        });
        if (!llmResp.ok) {
          const t = await llmResp.text().catch(() => '');
          console.error('[extractMedicationFromImages] OpenAI returned', llmResp.status, t.slice(0, 400));
          res.status(502).json({ error: 'Vision model error', status: llmResp.status });
          return;
        }
        const llmData = await llmResp.json();
        const raw = llmData?.choices?.[0]?.message?.content || '{}';
        try { parsed = JSON.parse(raw); }
        catch (e) {
          console.error('[extractMedicationFromImages] JSON parse failed:', e.message, raw.slice(0, 400));
          res.status(502).json({ error: 'Vision model returned invalid JSON' });
          return;
        }
      } catch (e) {
        console.error('[extractMedicationFromImages] OpenAI call failed:', e);
        res.status(502).json({ error: e.message || 'Vision call failed' });
        return;
      }

      // Sanitize + normalize the response
      const VALID_DAYS = new Set(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
      const VALID_UNITS = new Set(['hours','days','weeks']);
      const VALID_TYPES = new Set(['weekly','interval']);

      function strOrNull(v, maxLen = 200) {
        if (typeof v !== 'string') return null;
        const t = v.trim();
        if (!t) return null;
        return t.length > maxLen ? t.slice(0, maxLen) : t;
      }
      function intOrNull(v) {
        if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
        return null;
      }
      function isoDateOrNull(v) {
        if (typeof v !== 'string') return null;
        const t = v.trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
      }
      function mmddyyyyOrNull(v) {
        if (typeof v !== 'string') return null;
        const t = v.trim();
        return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) ? t : null;
      }
      function normTime(v) {
        if (typeof v !== 'string') return null;
        const t = v.trim();
        const m = t.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
        const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
        return String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
      }
      function clampConf(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.min(1, n));
      }

      const cleanSchedules = (() => {
        if (!Array.isArray(parsed.schedules)) return null;
        const out = [];
        for (const s of parsed.schedules) {
          if (!s || typeof s !== 'object') continue;
          const type = VALID_TYPES.has(s.type) ? s.type : null;
          if (!type) continue;
          const entry = { type };
          if (type === 'weekly') {
            entry.days = Array.isArray(s.days)
              ? s.days.map(d => String(d || '').toLowerCase().trim()).filter(d => VALID_DAYS.has(d))
              : null;
            if (entry.days && entry.days.length === 0) entry.days = null;
          } else {
            entry.every = intOrNull(s.every);
            entry.unit = VALID_UNITS.has(s.unit) ? s.unit : null;
          }
          entry.times = Array.isArray(s.times)
            ? s.times.map(normTime).filter(Boolean)
            : null;
          if (entry.times && entry.times.length === 0) entry.times = null;
          out.push(entry);
        }
        return out.length ? out : null;
      })();

      const cleanBottles = (() => {
        if (!Array.isArray(parsed.bottles)) return null;
        const out = [];
        for (const b of parsed.bottles) {
          if (!b || typeof b !== 'object') continue;
          const expiration = mmddyyyyOrNull(b.expiration);
          const quantity = intOrNull(b.quantity);
          if (expiration || quantity != null) out.push({ expiration, quantity });
        }
        return out.length ? out : null;
      })();

      const cleanConfidence = {};
      if (parsed.confidence && typeof parsed.confidence === 'object') {
        for (const [k, v] of Object.entries(parsed.confidence)) {
          const c = clampConf(v);
          if (c != null) cleanConfidence[k] = c;
        }
      }

      const cleanAmbiguities = Array.isArray(parsed.ambiguities)
        ? parsed.ambiguities.map(a => strOrNull(a, 300)).filter(Boolean).slice(0, 10)
        : [];

      // Sanitize extractedFrom — only allow the documented enum values.
      const VALID_SOURCES = new Set(['bottle', 'note', 'printout', 'mixed']);
      const cleanExtractedFrom = {};
      if (parsed.extractedFrom && typeof parsed.extractedFrom === 'object') {
        for (const [k, v] of Object.entries(parsed.extractedFrom)) {
          const s = typeof v === 'string' ? v.toLowerCase().trim() : null;
          if (s && VALID_SOURCES.has(s)) cleanExtractedFrom[k] = s;
        }
      }

      const out = {
        name: strOrNull(parsed.name, 120),
        genericName: strOrNull(parsed.genericName, 120),
        dosage: strOrNull(parsed.dosage, 80),
        dosageQuantity: intOrNull(parsed.dosageQuantity),
        schedules: cleanSchedules,
        startDate: isoDateOrNull(parsed.startDate),
        endDate: isoDateOrNull(parsed.endDate),
        bottles: cleanBottles,
        notes: strOrNull(parsed.notes, 500),
        confidence: cleanConfidence,
        ambiguities: cleanAmbiguities,
        extractedFrom: cleanExtractedFrom,
        imageCount: images.length,
      };

      console.log('[extractMedicationFromImages] ok:', out.name || '(no name)', '|', out.imageCount, 'image(s)');
      res.status(200).json(out);
    } catch (error) {
      console.error('[extractMedicationFromImages] error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

/**
 * chatWithAI
 * Receives conversation messages, calls OpenAI Chat Completions with tool support.
 */
exports.chatWithAI = functions.https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
      await admin.auth().verifyIdToken(idToken);

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      const { messages, tools, tool_choice } = req.body || {};
      if (!messages || !Array.isArray(messages)) { res.status(400).json({ error: 'Missing messages array' }); return; }

      const body = {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.1,
      };
      if (tools && tools.length) body.tools = tools;
      if (tool_choice) body.tool_choice = tool_choice;

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error('OpenAI chat error:', resp.status, errText.slice(0, 500));
        res.status(502).json({ error: `OpenAI returned ${resp.status}`, details: errText.slice(0, 300) });
        return;
      }

      const data = await resp.json();
      const choice = data.choices?.[0];
      console.log('Chat response:', (choice?.message?.content || '').slice(0, 100));
      res.status(200).json({ message: choice?.message || {} });
    } catch (error) {
      console.error('chatWithAI error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

/**
 * textToSpeech
 * Receives text, calls OpenAI TTS, returns audio as base64.
 */
exports.textToSpeech = functions.https.onRequest((req, res) => {
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  return cors(req, res, async () => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      const authHeader = req.headers.authorization || '';
      const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
      if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
      await admin.auth().verifyIdToken(idToken);

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      const { text, voice } = req.body || {};
      if (!text) { res.status(400).json({ error: 'Missing text' }); return; }

      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          input: text,
          voice: voice || 'verse',
          response_format: 'mp3',
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error('OpenAI TTS error:', resp.status, errText.slice(0, 500));
        res.status(502).json({ error: `OpenAI returned ${resp.status}`, details: errText.slice(0, 300) });
        return;
      }

      const arrayBuf = await resp.arrayBuffer();
      const base64Audio = Buffer.from(arrayBuf).toString('base64');
      console.log('TTS generated:', base64Audio.length, 'chars base64');
      res.status(200).json({ audio: base64Audio, mimeType: 'audio/mpeg' });
    } catch (error) {
      console.error('textToSpeech error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});

// ========================================================================
// TIMEZONE CHANGE DETECTION & MANAGEMENT
// ========================================================================

/**
 * requestTimezoneChangeEmail
 * Called from login.html when browser timezone differs from stored timezone.
 * Creates a pending timezone change request and emails the user a link.
 */
exports.requestTimezoneChangeEmail = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.body?.idToken || '');
    if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded?.uid) { res.status(401).json({ error: 'Invalid token' }); return; }

    const uid = decoded.uid;
    const { detectedTimezone } = req.body || {};
    if (!detectedTimezone || typeof detectedTimezone !== 'string') {
      res.status(400).json({ error: 'detectedTimezone is required' });
      return;
    }

    const dbRef = admin.firestore();
    const userSnap = await dbRef.collection('users').doc(uid).get();
    if (!userSnap.exists) { res.status(404).json({ error: 'User not found' }); return; }

    const userData = userSnap.data();
    const storedTimezone = userData.timezone || '';

    // If timezones match (or no stored timezone) — nothing to do
    if (!storedTimezone || storedTimezone === detectedTimezone) {
      res.status(200).json({ message: 'No timezone change detected', changed: false });
      return;
    }

    // Check for recent pending request to avoid spam
    const recentRequests = await dbRef.collection('users').doc(uid)
      .collection('timezoneRequests')
      .where('status', '==', 'pending')
      .where('newTimezone', '==', detectedTimezone)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (!recentRequests.empty) {
      const lastRequest = recentRequests.docs[0].data();
      const createdAt = lastRequest.createdAt?.toDate?.() || new Date(0);
      const hoursSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        res.status(200).json({ message: 'Timezone change request already pending', changed: false });
        return;
      }
    }

    // Create timezone change request
    const requestRef = dbRef.collection('users').doc(uid).collection('timezoneRequests').doc();
    await requestRef.set({
      originalTimezone: storedTimezone,
      newTimezone: detectedTimezone,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send email to user
    const userEmail = userData.email;
    const userName = userData.name || 'there';

    if (userEmail) {
      const link = `${APP_BASE_URL}/traveltimezone.html?request=${requestRef.id}`;

      const msg = {
        to: userEmail,
        from: { email: 'no-reply@everane.live', name: 'Everane' },
        subject: 'Did you change timezones?',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #0b1020; color: #e7ebf3;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="font-size: 1.6rem; margin: 0; color: #4f8cff;">Timezone Change Detected</h1>
            </div>
            <p style="font-size: 1rem; line-height: 1.6; color: #e7ebf3;">Hi ${userName},</p>
            <p style="font-size: 1rem; line-height: 1.6; color: #b1bad4;">We noticed you may have traveled or changed timezones.</p>
            <div style="background: #0f1629; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 16px 20px; margin: 20px 0;">
              <p style="margin: 0 0 8px; color: #b1bad4; font-size: 0.9rem;">Current timezone on file:</p>
              <p style="margin: 0 0 16px; color: #e7ebf3; font-weight: 700; font-size: 1.05rem;">${storedTimezone}</p>
              <p style="margin: 0 0 8px; color: #b1bad4; font-size: 0.9rem;">Detected timezone:</p>
              <p style="margin: 0; color: #7de2d1; font-weight: 700; font-size: 1.05rem;">${detectedTimezone}</p>
            </div>
            <p style="font-size: 0.95rem; line-height: 1.6; color: #b1bad4;">If you've traveled, you can update your timezone so reminders arrive at the right local time. If this was temporary, just keep your current timezone.</p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${link}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(180deg, #4f8cff, #3c74f7); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 1rem;">Choose Your Timezone</a>
            </div>
            <p style="font-size: 0.82rem; color: #b1bad4; text-align: center; margin-top: 32px;">This is an automated message from Everane.</p>
          </div>
        `,
        text: `Hi ${userName},\n\nWe noticed you may have changed timezones.\n\nCurrent timezone: ${storedTimezone}\nDetected timezone: ${detectedTimezone}\n\nClick here to update or keep your timezone: ${link}\n\n— Everane`
      };

      await sgMail.send(msg);
      console.log(`[Timezone] Sent timezone change email to ${userEmail} (${storedTimezone} -> ${detectedTimezone})`);
    }

    res.status(200).json({ message: 'Timezone change email sent', changed: true, requestId: requestRef.id });
  } catch (error) {
    console.error('[Timezone] requestTimezoneChangeEmail error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * getTimezoneChangeRequest
 * Fetches a pending timezone change request so traveltimezone.html can show it.
 */
exports.getTimezoneChangeRequest = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.body?.idToken || '');
    if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded?.uid) { res.status(401).json({ error: 'Invalid token' }); return; }

    const { requestId } = req.body || {};
    if (!requestId) { res.status(400).json({ error: 'requestId is required' }); return; }

    const docSnap = await admin.firestore()
      .collection('users').doc(decoded.uid)
      .collection('timezoneRequests').doc(requestId)
      .get();

    if (!docSnap.exists) {
      res.status(404).json({ error: 'Timezone change request not found' });
      return;
    }

    const data = docSnap.data();
    res.status(200).json({
      status: data.status,
      originalTimezone: data.originalTimezone,
      newTimezone: data.newTimezone
    });
  } catch (error) {
    console.error('[Timezone] getTimezoneChangeRequest error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * resolveTimezoneChange
 * User chose to "stay" at original timezone or "change" to new one.
 */
exports.resolveTimezoneChange = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.body?.idToken || '');
    if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded?.uid) { res.status(401).json({ error: 'Invalid token' }); return; }

    const { requestId, action } = req.body || {};
    if (!requestId) { res.status(400).json({ error: 'requestId is required' }); return; }
    if (!action || !['stay', 'change'].includes(action)) {
      res.status(400).json({ error: 'action must be "stay" or "change"' });
      return;
    }

    const uid = decoded.uid;
    const dbRef = admin.firestore();
    const requestRef = dbRef.collection('users').doc(uid).collection('timezoneRequests').doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    const requestData = requestSnap.data();
    if (requestData.status !== 'pending') {
      res.status(400).json({ error: 'Request already resolved' });
      return;
    }

    // Apply the change
    if (action === 'change') {
      await dbRef.collection('users').doc(uid).set({
        timezone: requestData.newTimezone
      }, { merge: true });
      console.log(`[Timezone] User ${uid} changed timezone: ${requestData.originalTimezone} -> ${requestData.newTimezone}`);
    } else {
      console.log(`[Timezone] User ${uid} chose to stay at: ${requestData.originalTimezone}`);
    }

    // Mark as resolved
    await requestRef.update({
      status: 'resolved',
      action: action,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({
      message: action === 'change'
        ? `Timezone updated to ${requestData.newTimezone}. Your reminders will follow the new timezone.`
        : `Timezone kept as ${requestData.originalTimezone}.`,
      timezone: action === 'change' ? requestData.newTimezone : requestData.originalTimezone
    });
  } catch (error) {
    console.error('[Timezone] resolveTimezoneChange error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * One-time callable: Backfill patientId for all existing users who don't have one.
 * Call via: https://us-central1-medtracker-8c467.cloudfunctions.net/backfillPatientIds
 */
exports.backfillPatientIds = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const db = admin.firestore();
      const usersSnap = await db.collection('users').get();
      let backfilled = 0;
      let skipped = 0;

      for (const userDoc of usersSnap.docs) {
        const data = userDoc.data();
        if (data.patientId) {
          skipped++;
          continue;
        }
        const newId = await generateUniquePatientId(db);
        await db.collection('users').doc(userDoc.id).set({ patientId: newId }, { merge: true });
        backfilled++;
        console.log(`[Backfill] ${userDoc.id} -> ${newId}`);
      }

      res.status(200).json({ success: true, backfilled, skipped, total: usersSnap.size });
    } catch (error) {
      console.error('[Backfill] Error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

/**
 * Doctor login — validates patientId + doctorPassword server-side.
 * Returns the patient's Firebase UID on success so the frontend can load their data.
 */
exports.doctorLogin = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { patientId, password } = req.body;

      if (!patientId || !password) {
        res.status(400).json({ error: 'Patient ID and password are required.' });
        return;
      }

      const db = admin.firestore();
      const snap = await db.collection('users')
        .where('patientId', '==', String(patientId))
        .limit(1)
        .get();

      if (snap.empty) {
        res.status(401).json({ error: 'Invalid Patient ID or password.' });
        return;
      }

      const userDoc = snap.docs[0];
      const userData = userDoc.data();

      if (!userData.doctorPassword) {
        res.status(401).json({ error: 'Invalid Patient ID or password.' });
        return;
      }

      if (userData.doctorPassword !== password) {
        res.status(401).json({ error: 'Invalid Patient ID or password.' });
        return;
      }

      // Fetch medications for this patient
      const medsSnap = await db.collection('users').doc(userDoc.id).collection('medications').get();
      const medications = [];
      const dayMap = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

      // Helper to convert Firestore Timestamps or date strings to ISO string
      function toDateStr(val) {
        if (!val) return null;
        if (val.toDate) return val.toDate().toISOString(); // Firestore Timestamp
        if (val._seconds) return new Date(val._seconds * 1000).toISOString(); // Serialized Timestamp
        if (typeof val === 'string') return val;
        return null;
      }

      medsSnap.forEach(medDoc => {
        const d = medDoc.data();
        if (d.deletedStatus === true) return;

        const timesSet = new Set();
        const daysSet = new Set();
        const intervalSchedules = [];

        if (d.schedules && d.schedules.length > 0) {
          d.schedules.forEach(s => {
            if (s.type === 'WEEKLY') {
              if (s.time) timesSet.add(s.time);
              if (s.weekday !== undefined && s.weekday !== null) {
                daysSet.add(dayMap[s.weekday] || String(s.weekday));
              }
            } else if (s.type === 'INTERVAL') {
              if (s.interval) {
                intervalSchedules.push({
                  value: s.interval.value,
                  unit: s.interval.unit
                });
              }
              if (s.anchorDateTime) {
                const match = String(s.anchorDateTime).match(/T?(\d{2}:\d{2})/);
                if (match) timesSet.add(match[1]);
              }
            }
            // Also check startDate/endDate at the schedule level
            if (s.startDate) {
              const sd = toDateStr(s.startDate);
              if (sd) d._startDate = d._startDate || sd;
            }
          });
        }

        const times = [...timesSet].sort();
        const days = [...daysSet];

        // Build interval description if present
        let intervalDesc = '';
        if (intervalSchedules.length > 0) {
          const iv = intervalSchedules[0];
          const unitLabel = iv.unit === 'DAY' ? 'day' : iv.unit === 'WEEK' ? 'week' : iv.unit.toLowerCase();
          intervalDesc = `Every ${iv.value} ${unitLabel}${iv.value > 1 ? 's' : ''}`;
        }

        medications.push({
          name: d.name || 'Unnamed',
          dosage: d.dosage || '',
          dosageUnit: d.dosageUnit || '',
          times,
          days,
          timesPerDay: d.timesPerDay || times.length || 0,
          startDate: toDateStr(d.startDate) || d._startDate || null,
          endDate: toDateStr(d.endDate) || null,
          intervalDesc
        });
      });
      medications.sort((a, b) => a.name.localeCompare(b.name));

      // Success — return patient info + medications
      res.status(200).json({
        success: true,
        uid: userDoc.id,
        name: userData.name || '',
        email: userData.email || '',
        medications
      });
    } catch (error) {
      console.error('[DoctorLogin] Error:', error);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });
});

/**
 * Doctor: get patient medications — accepts uid (already validated at login).
 * Returns list of active medications (name, dosage, schedule).
 */
/**
 * Doctor: submit an edit request for a patient.
 * Saves to Firestore at users/{uid}/doctorEdits/{autoId}
 */
exports.submitDoctorEdit = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { uid, type, details, doctorName } = req.body;

      if (!uid || !type || !details) {
        res.status(400).json({ error: 'uid, type, and details are required.' });
        return;
      }

      const db = admin.firestore();

      // Verify user exists and has doctor access
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().doctorPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const now = new Date().toISOString();

      const editData = {
        type,
        details,
        doctorName: doctorName || 'Doctor',
        createdAt: now,
        status: 'pending'
      };

      const docRef = await db.collection('users').doc(uid).collection('doctorEdits').add(editData);

      res.status(200).json({ success: true, id: docRef.id, edit: editData });
    } catch (error) {
      console.error('[submitDoctorEdit] Error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
});

/**
 * Doctor: get all edit requests for a patient.
 * Returns from users/{uid}/doctorEdits ordered by createdAt descending.
 */
exports.getDoctorEdits = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { uid } = req.body;

      if (!uid) {
        res.status(400).json({ error: 'uid is required.' });
        return;
      }

      const db = admin.firestore();

      // Verify user exists and has doctor access
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().doctorPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const editsSnap = await db.collection('users').doc(uid).collection('doctorEdits')
        .orderBy('createdAt', 'desc')
        .get();

      const edits = [];
      editsSnap.forEach(doc => {
        edits.push({ id: doc.id, ...doc.data() });
      });

      res.status(200).json({ success: true, edits });
    } catch (error) {
      console.error('[getDoctorEdits] Error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
});

/**
 * Doctor: reply to an existing edit request.
 * Appends a reply to the replies array on the doctorEdit document.
 */
exports.replyToDoctorEdit = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { uid, editId, message, doctorName } = req.body;

      if (!uid || !editId || !message) {
        res.status(400).json({ error: 'uid, editId, and message are required.' });
        return;
      }

      const db = admin.firestore();

      // Verify user exists and has doctor access
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().doctorPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Verify the edit exists
      const editDoc = await db.collection('users').doc(uid).collection('doctorEdits').doc(editId).get();
      if (!editDoc.exists) {
        res.status(404).json({ error: 'Edit not found.' });
        return;
      }

      const now = new Date().toISOString();
      const reply = {
        message,
        doctorName: doctorName || 'Doctor',
        createdAt: now
      };

      // Append to replies array
      const existing = editDoc.data().replies || [];
      existing.push(reply);
      await db.collection('users').doc(uid).collection('doctorEdits').doc(editId).update({
        replies: existing
      });

      res.status(200).json({ success: true, reply });
    } catch (error) {
      console.error('[replyToDoctorEdit] Error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
});

/**
 * Patient: submit a comment/update visible to doctors.
 * Saves to users/{uid}/doctorEdits with source:'patient'.
 * Authenticated via Firebase ID token.
 */
exports.submitPatientComment = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { uid, idToken, type, details, patientName } = req.body;

      if (!uid || !idToken || !type || !details) {
        res.status(400).json({ error: 'uid, idToken, type, and details are required.' });
        return;
      }

      // Verify the Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      if (decodedToken.uid !== uid) {
        res.status(401).json({ error: 'Unauthorized — token mismatch.' });
        return;
      }

      const db = admin.firestore();
      const now = new Date().toISOString();

      const commentData = {
        type,
        details,
        source: 'patient',
        patientName: patientName || 'Patient',
        createdAt: now,
        status: 'pending'
      };

      const docRef = await db.collection('users').doc(uid).collection('doctorEdits').add(commentData);

      res.status(200).json({ success: true, id: docRef.id, comment: commentData });
    } catch (error) {
      console.error('[submitPatientComment] Error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
});

exports.getDoctorPatientMeds = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const { uid } = req.body;

      if (!uid) {
        res.status(400).json({ error: 'UID is required.' });
        return;
      }

      const db = admin.firestore();

      // Verify the user exists and has a doctorPassword set (i.e. doctor access was enabled)
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().doctorPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // Fetch medications
      const medsSnap = await db.collection('users').doc(uid).collection('medications').get();
      const medications = [];

      medsSnap.forEach(medDoc => {
        const d = medDoc.data();
        if (d.deletedStatus === true) return;

        // Collect times from schedules or legacy fields
        let times = [];
        let days = [];
        if (d.schedules && d.schedules.length > 0) {
          d.schedules.forEach(s => {
            if (Array.isArray(s.times)) times.push(...s.times);
            if (Array.isArray(s.daysOfWeek)) days.push(...s.daysOfWeek);
          });
          // De-duplicate
          times = [...new Set(times)].sort();
          days = [...new Set(days)];
        } else {
          if (Array.isArray(d.times)) times = d.times.filter(Boolean).sort();
          if (Array.isArray(d.daysOfWeek || d.days)) days = (d.daysOfWeek || d.days || []);
        }

        medications.push({
          name: d.name || 'Unnamed',
          dosage: d.dosage || '',
          times,
          days
        });
      });

      // Sort alphabetically
      medications.sort((a, b) => a.name.localeCompare(b.name));

      res.status(200).json({ success: true, medications });
    } catch (error) {
      console.error('[getDoctorPatientMeds] Error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
});

/**
 * One-shot migration: for every medication that has `reminderMethod` but no `reminderChannels`,
 * derive `reminderChannels` from the legacy field and write it.
 *
 * Callable from the CLI:
 *   curl -X POST "https://<region>-<project>.cloudfunctions.net/migrateReminderMethodToChannels?token=<MIGRATION_TOKEN>"
 *
 * Uses the `migration.token` functions config value as a shared secret. Dry-run by default;
 * pass &dryRun=false to actually write.
 */
exports.migrateReminderMethodToChannels = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const expectedToken = functions.config().migration?.token || process.env.MIGRATION_TOKEN;
  const providedToken = (data && data.token) || '';
  if (!expectedToken || providedToken !== expectedToken) {
    throw new functions.https.HttpsError('permission-denied', 'Invalid token.');
  }
  const dryRun = !(data && data.dryRun === false);
  try {

    const db = admin.firestore();
    const usersSnap = await db.collection('users').get();

    let usersScanned = 0;
    let medsScanned = 0;
    let medsUpdated = 0;
    const perUserWrites = [];

    for (const userDoc of usersSnap.docs) {
      usersScanned++;
      const medsSnap = await userDoc.ref.collection('medications').get();
      for (const medDoc of medsSnap.docs) {
        medsScanned++;
        const data = medDoc.data() || {};
        // Skip if already has reminderChannels as an array
        if (Array.isArray(data.reminderChannels)) continue;
        const method = data.reminderMethod;
        let channels = null;
        if (method === 'E' || method === 'Email') channels = ['email'];
        else if (method === 'S' || method === 'SMS') channels = ['sms'];
        else if (method === 'ES') channels = ['email', 'sms'];
        else if (method === 'N' || method === 'None' || !method) channels = [];
        if (channels === null) continue;
        medsUpdated++;
        if (!dryRun) {
          perUserWrites.push(medDoc.ref.set({ reminderChannels: channels }, { merge: true }));
        }
      }
    }

    if (!dryRun && perUserWrites.length > 0) {
      // Fire them in reasonable chunks
      const chunkSize = 250;
      for (let i = 0; i < perUserWrites.length; i += chunkSize) {
        await Promise.all(perUserWrites.slice(i, i + chunkSize));
      }
    }

    return {
      ok: true,
      dryRun,
      usersScanned,
      medsScanned,
      medsUpdated
    };
  } catch (err) {
    console.error('[migrateReminderMethodToChannels] error:', err);
    throw new functions.https.HttpsError('internal', err.message || 'Migration failed');
  }
});

/**
 * Callable endpoint used by the service worker when a user clicks the
 * "Taken" or "Not Taken" action button directly on a Web Push notification.
 * Marks the specified dose in Firestore without the app needing to be open.
 */
exports.markDoseFromPush = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = context.auth.uid;
  const medId = String(data?.medId || '').trim();
  const doseDate = String(data?.doseDate || '').trim();
  const doseNumber = Number(data?.doseNumber);
  const doseTime = String(data?.doseTime || '').trim();
  const taken = data?.taken === true;

  if (!medId || !doseDate || !Number.isFinite(doseNumber) || doseNumber < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing medId, doseDate, or doseNumber.');
  }
  // ISO date sanity check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doseDate)) {
    throw new functions.https.HttpsError('invalid-argument', 'doseDate must be YYYY-MM-DD.');
  }

  const db = admin.firestore();
  const medRef = db.collection('users').doc(uid).collection('medications').doc(medId);
  const snap = await medRef.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Medication not found.');
  }

  const doseKey = `${doseDate}_${doseNumber}`;
  const nowIso = new Date().toISOString();
  const entry = {
    date: doseDate,
    doseNumber,
    taken,
    takenAt: taken ? nowIso : null,
    autoMarked: false,
    source: 'push-action'
  };
  if (doseTime) entry.time = doseTime;

  await medRef.update({
    [`doses.${doseKey}`]: entry
  });

  console.log(`[markDoseFromPush] uid=${uid} med=${medId} dose=${doseKey} taken=${taken}`);
  return { ok: true, doseKey, taken };
});

/**
 * Diagnostic: dump the caller's own lastSentReminders + med config.
 * Pure read-only. Useful for figuring out why a reminder didn't fire.
 */
/**
 * Return the caller's push subscriptions with friendly device names parsed
 * from the user-agent string, plus a `here` flag for whichever subscription
 * matches the endpoint the caller passes in (so the UI can highlight "this device").
 *
 * Args: { hereEndpoint?: string }
 * Returns: { ok, devices: [{ endpoint, label, createdAt, here }] }
 */
exports.listMyPushSubscriptions = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const hereEndpoint = (data && data.hereEndpoint) || null;
  const db = admin.firestore();
  const snap = await db.collection('users').doc(uid).get();
  const subs = (snap.exists ? (snap.data().pushSubscriptions || []) : []).filter(Boolean);

  // Parse a friendly device label from the user-agent string.
  function labelFromUA(ua) {
    ua = String(ua || '');
    let device = 'Unknown device';
    let browser = '';
    if (/iPhone/.test(ua))              device = 'iPhone';
    else if (/iPad/.test(ua))           device = 'iPad';
    else if (/Android/.test(ua))        device = 'Android phone';
    else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
    else if (/Windows/.test(ua))        device = 'Windows PC';
    else if (/Linux/.test(ua))          device = 'Linux';
    if (/EdgA?\//.test(ua))             browser = 'Edge';
    else if (/Firefox/.test(ua))        browser = 'Firefox';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/CriOS|Chrome/.test(ua) && !/Edg/.test(ua)) browser = 'Chrome';
    else if (/Safari/.test(ua))         browser = 'Safari';
    return browser ? `${device} \u2014 ${browser}` : device;
  }

  const devices = subs.map(s => ({
    endpoint: s.endpoint,
    label: labelFromUA(s.userAgent),
    createdAt: s.createdAt || null,
    here: !!hereEndpoint && s.endpoint === hereEndpoint
  }));
  return { ok: true, devices };
});

/**
 * Remove one specific push subscription (by endpoint) from the caller's user doc.
 * Lets the user revoke a lost / old device's push without affecting other devices.
 *
 * Args: { endpoint: string }
 */
exports.removePushSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const endpoint = data && data.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'endpoint is required.');
  }
  const db = admin.firestore();
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  const existing = (snap.exists ? (snap.data().pushSubscriptions || []) : []).filter(Boolean);
  const filtered = existing.filter(s => s && s.endpoint !== endpoint);
  await userRef.set({ pushSubscriptions: filtered }, { merge: true });
  return { ok: true, removed: existing.length - filtered.length, remaining: filtered.length };
});

/**
 * Fire a test push to a single specific device (identified by its endpoint).
 * Lets the user verify each device individually from profile.
 *
 * Args: { endpoint: string }
 */
exports.testPushToDevice = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const endpoint = data && data.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'endpoint is required.');
  }
  if (!vapidPublic || !vapidPrivate) {
    throw new functions.https.HttpsError('failed-precondition', 'VAPID not configured.');
  }

  const db = admin.firestore();
  const snap = await db.collection('users').doc(uid).get();
  const subs = (snap.exists ? (snap.data().pushSubscriptions || []) : []).filter(Boolean);
  const sub = subs.find(s => s.endpoint === endpoint);
  if (!sub) {
    throw new functions.https.HttpsError('not-found', 'That device is not subscribed.');
  }

  const payload = {
    title: 'Everane test',
    body: 'Push notifications are working on this device.',
    tag: `test-${Date.now()}`,
    requireInteraction: false,
    data: { url: `${APP_BASE_URL}/profile.html` }
  };

  const result = await sendPushToSubscriptions(db, uid, [sub], payload);
  return { ok: result.sent > 0, sent: result.sent, pruned: result.pruned };
});

/**
 * Clear all of today's dedup keys for the caller. Useful when emails/SMSes
 * appear "already sent" in lastSentReminders but the user never received them
 * (Gmail spam, carrier filtering, etc.) — calling this lets the next cron
 * cycle re-fire reminders for today's remaining doses.
 */
exports.resetTodayDedup = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const db = admin.firestore();
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { ok: false, error: 'user doc not found' };
  const u = userSnap.data() || {};
  const userTimezone = u.timezone || DEFAULT_TIME_ZONE;
  const todayIso = getNowInZone(userTimezone).toISODate();
  const lastSent = u.lastSentReminders || {};
  const removed = [];
  Object.keys(lastSent).forEach(key => {
    if (key.includes(`|${todayIso}`)) {
      removed.push(key);
      delete lastSent[key];
    }
  });
  if (removed.length > 0) {
    await db.collection('users').doc(uid).set({ lastSentReminders: lastSent }, { merge: true });
  }
  return { ok: true, removed, count: removed.length, todayIso };
});

/**
 * Safer cleanup: remove all stale (non-today) dedup keys and any leftover
 * pre-channel-format keys that haven't been migrated yet.
 *
 * Does NOT touch today's keys, so this won't cause already-fired-today
 * reminders to re-fire and spam the user.
 *
 * Use this once after a major reminder-pipeline rewrite to clean up the doc.
 */
exports.cleanStaleDedup = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const db = admin.firestore();
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { ok: false, error: 'user doc not found' };
  const u = userSnap.data() || {};
  const userTimezone = u.timezone || DEFAULT_TIME_ZONE;
  const todayIso = getNowInZone(userTimezone).toISODate();
  const lastSent = u.lastSentReminders || {};
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;

  const removedStale = [];
  const removedLegacy = [];

  Object.keys(lastSent).forEach(key => {
    const parts = key.split('|');
    const last = parts[parts.length - 1];
    const isChannelKey = last === 'email' || last === 'sms' || last === 'push';

    if (isChannelKey) {
      // New format. Date is second-to-last.
      const d = parts[parts.length - 2];
      if (isoDate.test(d) && d !== todayIso) {
        removedStale.push(key);
        delete lastSent[key];
      }
    } else if (isoDate.test(last)) {
      // Legacy pre-channel format. Always remove.
      removedLegacy.push(key);
      delete lastSent[key];
    } else {
      // Unrecognized shape — also remove.
      removedLegacy.push(key);
      delete lastSent[key];
    }
  });

  await db.collection('users').doc(uid).set({ lastSentReminders: lastSent }, { merge: true });
  return {
    ok: true,
    todayIso,
    removedStaleCount: removedStale.length,
    removedLegacyCount: removedLegacy.length,
    remainingCount: Object.keys(lastSent).length,
    removedStale: removedStale.slice(0, 20),
    removedLegacy: removedLegacy.slice(0, 20)
  };
});

exports.dumpMyReminderDiagnostics = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const db = admin.firestore();
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { ok: false, error: 'user doc not found' };
  const u = userSnap.data() || {};
  const lastSent = u.lastSentReminders || {};
  const medsSnap = await db.collection('users').doc(uid).collection('medications').get();
  const meds = medsSnap.docs
    .map(d => ({ id: d.id, ...(d.data() || {}) }))
    .filter(m => !m.deletedStatus)
    .map(m => ({
      id: m.id,
      name: m.name,
      reminderMethod: m.reminderMethod,
      reminderChannels: m.reminderChannels,
      scheduleTimes: Array.isArray(m.schedules) ? m.schedules.map(s => s.time).filter(Boolean) : [],
      doses: m.doses || {}
    }));

  // Recent send attempts (last 100, newest first) — invaluable for debugging
  // why a particular reminder didn't deliver.
  const auditSnap = await db.collection('users').doc(uid).collection('sendAuditLog')
    .orderBy('ts', 'desc').limit(100).get();
  const recentAttempts = auditSnap.docs.map(d => d.data());

  return {
    ok: true,
    uid,
    timezone: u.timezone || null,
    phone: u.phone || null,
    phoneVerified: !!u.phoneVerified,
    notification_reminders: u.notification_reminders || [],
    pushSubscriptionCount: Array.isArray(u.pushSubscriptions) ? u.pushSubscriptions.length : 0,
    lastSentReminders: lastSent,
    lastAgendaSentDate: u.lastAgendaSentDate || null,
    recentAttempts,
    meds
  };
});

/**
 * Manual test-fire callable. Sends a reminder NOW to the caller, on every
 * channel they request, regardless of dedup or schedule. Returns a per-channel
 * result so we can see exactly which channels work end-to-end.
 *
 * Args (all optional):
 *   { channels: ['email','sms','push'],   // default: all channels the caller has set up
 *     medId: 'optional-medId-to-use-as-payload' }
 *
 * If no medId given, uses the caller's first non-deleted medication for content.
 */
exports.testFireReminder = functions.runWith({ timeoutSeconds: 60 }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = context.auth.uid;
  const db = admin.firestore();

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'User document not found.');
  }
  const u = userSnap.data() || {};
  const userEmail = u.email;
  const userPhoneNumber = u.phone || null;
  const phoneVerified = !!u.phoneVerified;
  const userTimezone = u.timezone || DEFAULT_TIME_ZONE;
  const subs = Array.isArray(u.pushSubscriptions) ? u.pushSubscriptions : [];

  // Pick a medication for the test payload
  let med = null;
  if (data && data.medId) {
    const medSnap = await db.collection('users').doc(uid).collection('medications').doc(String(data.medId)).get();
    if (medSnap.exists) med = { id: medSnap.id, ...medSnap.data() };
  }
  if (!med) {
    const medsSnap = await db.collection('users').doc(uid).collection('medications').limit(20).get();
    const cand = medsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) })).find(m => !m.deletedStatus);
    if (cand) med = cand;
  }
  // Fall back to a synthetic med so we can still test
  if (!med) {
    med = { id: 'test-med', name: '[TEST] Sample Medication', dosage: '1 pill', schedules: [] };
  }

  const requestedChannels = Array.isArray(data && data.channels) && data.channels.length > 0
    ? data.channels.map(c => String(c).toLowerCase())
    : ['email', 'sms', 'push'];

  const now = getNowInZone(userTimezone);
  const todayIso = now.toISODate();
  const time24 = now.toFormat('HH:mm');

  const results = {
    timestamp: now.toISO(),
    userEmail,
    userPhoneNumber,
    phoneVerified,
    pushSubscriptionCount: subs.length,
    config: {
      gmail: !!gmailEmail && !!gmailPassword,
      twilio: !!twilioClient && !!twilioFromNumber,
      vapid: !!vapidPublic && !!vapidPrivate
    },
    channels: {}
  };

  // EMAIL
  if (requestedChannels.includes('email')) {
    if (!userEmail) {
      results.channels.email = { ok: false, reason: 'no-email-on-account' };
    } else if (!gmailEmail || !gmailPassword) {
      results.channels.email = { ok: false, reason: 'gmail-not-configured' };
    } else {
      try {
        const medForEmail = { ...med, _doseNumber: 1, _doseTime: time24 };
        await sendCombinedReminderEmail(
          userEmail, [medForEmail], time24, 'at_time',
          [], [], [], userTimezone,
          '[TEST] '
        );
        await recordSendAttempt(db, uid, {
          channel: 'email', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso, status: 'sent', reason: 'manual test'
        });
        results.channels.email = { ok: true };
      } catch (e) {
        await recordSendAttempt(db, uid, {
          channel: 'email', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso, status: 'failed',
          error: (e && e.message) || String(e), reason: 'manual test'
        });
        results.channels.email = { ok: false, reason: 'send-threw', error: (e && e.message) || String(e) };
      }
    }
  }

  // SMS
  if (requestedChannels.includes('sms')) {
    if (!userPhoneNumber) {
      results.channels.sms = { ok: false, reason: 'no-phone-on-account' };
    } else if (!phoneVerified) {
      results.channels.sms = { ok: false, reason: 'phone-not-verified' };
    } else if (!twilioClient || !twilioFromNumber) {
      results.channels.sms = { ok: false, reason: 'twilio-not-configured' };
    } else {
      try {
        const medForSms = { ...med, _doseNumber: 1, _doseTime: time24 };
        const twilioResult = await sendCombinedReminderSMS(
          userPhoneNumber, [medForSms], time24, 'at_time',
          [], [], [], userTimezone
        );
        const sid = twilioResult && (twilioResult.sid || twilioResult.id);
        await recordSendAttempt(db, uid, {
          channel: 'sms', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso, status: 'sent',
          reason: `manual test (sid=${sid || 'unknown'})`
        });

        // Wait ~6s then poll Twilio for the actual delivery status. This catches
        // the case where Twilio accepts the request but the carrier rejects it
        // (TFV pending, blocked content, invalid number, etc.).
        let deliveryReport = null;
        if (sid) {
          await new Promise(r => setTimeout(r, 6000));
          deliveryReport = await getSmsDeliveryStatus(sid, userPhoneNumber);
        }

        // Detect carrier rejection from the delivery report. Twilio uses
        // status='failed'|'undelivered' and errorCode (e.g. 30007 = carrier
        // filtered, 30003 = unreachable, 30005 = unknown destination).
        let carrierFailed = false;
        if (deliveryReport && !deliveryReport.error) {
          const status = String(deliveryReport.status || '').toLowerCase();
          if (status === 'failed' || status === 'undelivered') {
            carrierFailed = true;
          }
        }

        // SPEC v2: NO fallback email when SMS is carrier-rejected on the test
        // fire either — same rule as the cron pipeline. The user picked SMS;
        // if the carrier blocked it, that's what we report. We do not auto-send
        // an email behind their back.
        // Populate `reason` so the UI doesn't say "reason=?" when SMS fails.
        const smsReason = carrierFailed
          ? `carrier-rejected (status=${deliveryReport && deliveryReport.status}, code=${deliveryReport && deliveryReport.code})`
          : (deliveryReport && deliveryReport.error ? 'no-delivery-report' : null);

        // Surface raw message metadata to the caller so they can see Twilio's view
        results.channels.sms = {
          ok: !carrierFailed,
          reason: smsReason,
          carrierFailed,
          sid,
          messageSummary: twilioResult ? {
            sid: twilioResult.sid,
            status: twilioResult.status,
            dateCreated: twilioResult.dateCreated,
            errorCode: twilioResult.errorCode,
            errorMessage: twilioResult.errorMessage,
            from: twilioResult.from,
            to: twilioResult.to,
          } : null,
          deliveryReport
        };
      } catch (e) {
        await recordSendAttempt(db, uid, {
          channel: 'sms', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso, status: 'failed',
          error: (e && e.message) || String(e), reason: 'manual test'
        });
        results.channels.sms = { ok: false, reason: 'send-threw', error: (e && e.message) || String(e) };
      }
    }
  }

  // PUSH
  if (requestedChannels.includes('push')) {
    if (subs.length === 0) {
      results.channels.push = { ok: false, reason: 'no-subscriptions' };
    } else if (!vapidPublic || !vapidPrivate) {
      results.channels.push = { ok: false, reason: 'vapid-not-configured' };
    } else {
      try {
        const payload = buildSingleMedPushPayload(
          { ...med, _doseNumber: 1, _doseTime: time24, _isAlreadyTaken: false },
          time24, 'at_time', userTimezone, todayIso
        );
        // Tag uniquely so the test push doesn't get coalesced with a real one
        payload.tag = `test-${Date.now()}`;
        payload.title = '[TEST] ' + payload.title;
        const r = await sendPushToSubscriptions(db, uid, subs, payload);
        await recordSendAttempt(db, uid, {
          channel: 'push', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso,
          status: r.sent > 0 ? 'sent' : 'failed',
          reason: `manual test: ${r.sent} delivered, ${r.pruned} pruned`
        });
        results.channels.push = { ok: r.sent > 0, sent: r.sent, pruned: r.pruned };
      } catch (e) {
        await recordSendAttempt(db, uid, {
          channel: 'push', medId: med.id, medName: med.name,
          doseNumber: 1, doseTime: time24, offsetKey: 'at_time',
          date: todayIso, status: 'failed',
          error: (e && e.message) || String(e), reason: 'manual test'
        });
        results.channels.push = { ok: false, reason: 'send-threw', error: (e && e.message) || String(e) };
      }
    }
  }

  return { ok: true, results };
});

