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
const { SinchClient } = require('@sinch/sdk-core');
const cors = require('cors')({ origin: true });
const ScheduleUtils = require('./schedule-utils');

admin.initializeApp();

// Configure your email service (Gmail example)
// For production, use environment config: firebase functions:config:set gmail.email="your@gmail.com" gmail.password="your-app-password"
const gmailEmail = functions.config().gmail?.email || process.env.GMAIL_EMAIL;
const gmailPassword = functions.config().gmail?.password || process.env.GMAIL_PASSWORD;

// Base URL for the app (for email links)
// For production, set: firebase functions:config:set app.baseurl="https://your-app.netlify.app"
// Or use environment variable: APP_BASE_URL
const APP_BASE_URL = functions.config().app?.baseurl || process.env.APP_BASE_URL || 'https://melodious-selkie-5d4511.netlify.app';

// Sinch configuration
// firebase functions:config:set sinch.projectid="..." sinch.keyid="..." sinch.keysecret="..." sinch.phonenumber="..."
const sinchProjectId = functions.config().sinch?.projectid || process.env.SINCH_PROJECT_ID;
const sinchKeyId = functions.config().sinch?.keyid || process.env.SINCH_KEY_ID;
const sinchKeySecret = functions.config().sinch?.keysecret || process.env.SINCH_KEY_SECRET;
const sinchPhoneNumber = functions.config().sinch?.phonenumber || process.env.SINCH_PHONE_NUMBER;
// Initialize Sinch client for SMS
let sinchSmsClient = null;
if (sinchProjectId && sinchKeyId && sinchKeySecret) {
  sinchSmsClient = new SinchClient({
    projectId: sinchProjectId,
    keyId: sinchKeyId,
    keySecret: sinchKeySecret
  });
  console.log('✅ Sinch SMS client initialized');
} else {
  console.error('⚠️ SINCH SMS CONFIGURATION MISSING:');
  console.error('  SMS sending will fail. Please configure Sinch credentials.');
  console.error('  Run: firebase functions:config:set sinch.projectid="..." sinch.keyid="..." sinch.keysecret="..."');
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
 * Helper function to send SMS via Sinch
 * @param {string} phoneNumber - Recipient phone number (E.164 format)
 * @param {string} message - SMS message text
 * @returns {Promise} - Sinch batch response
 */
async function sendSMS(phoneNumber, message) {
  if (!sinchSmsClient) {
    throw new Error('Sinch SMS client not initialized');
  }

  if (!sinchPhoneNumber) {
    throw new Error('Sinch phone number not configured');
  }

  try {
    const result = await sinchSmsClient.sms.batches.send({
      sendSMSRequestBody: {
        to: [phoneNumber],
        from: sinchPhoneNumber,
        body: message,
        type: 'mt_text'
      }
    });

    console.log(`✅ SMS sent to ${phoneNumber}: ${result.id}`);
    return result;
  } catch (error) {
    console.error(`❌ Error sending SMS to ${phoneNumber}:`, error);
    throw error;
  }
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
const WINDOW_MINUTES = 1; // Window for sending reminders - 1 minute to catch exact time (function runs every 1 minute)
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
  const weekdayIndex = nowDateTime.weekday % 7; // Luxon weekday: Monday=1 ... Sunday=7 -> convert to 0-based Sunday
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = weekdays[weekdayIndex];
  
  console.log(`  shouldSendReminderToday for ${med.name}:`);
  console.log(`    Today is: ${todayName} (weekday index: ${weekdayIndex})`);
  
  // Check if medication is deleted
  if (med.deletedStatus === true) {
    console.log(`    -> Skipping ${med.name} (deleted)`);
    return false;
  }
  
  // Check if end date has passed
  // Note: parseEndDate will use the timezone from nowDateTime
  const userTimezone = nowDateTime.zoneName;
  const endDate = parseEndDate(med.endDate, userTimezone);
  if (endDate && nowDateTime > endDate) {
    console.log(`    -> Skipping ${med.name} (end date ${endDate.toISODate()} has passed, now ${nowDateTime.toISODate()})`);
    return false;
  }

  // New: Check schedules
  if (med.schedules && med.schedules.length > 0) {
    const result = ScheduleUtils.isScheduledForDate(med.schedules, nowDateTime);
    console.log(`    -> Using schedules[] format: isScheduledForDate=${result}`);
    if (result) {
      console.log(`    -> PASSED: Should send reminder today (via schedules)`);
    } else {
      console.log(`    -> Skipping ${med.name} (not scheduled for today via schedules)`);
    }
    return result;
  }

  // Existing fallback for unmigrated data below...
  // Check if today is in the selected days
  // Normalize daysOfWeek - handle both array of strings and array of numbers
  const daysOfWeek = med.daysOfWeek || med.days || [];
  if (daysOfWeek.length > 0) {
    // Convert to lowercase strings for comparison
    const normalizedDays = daysOfWeek.map(day => {
      if (typeof day === 'number') {
        // Convert number (0-6) to day name
        return weekdays[day % 7];
      }
      return String(day).toLowerCase();
    });
    
    const todaySelected = normalizedDays.includes(todayName);
    console.log(`    daysOfWeek: ${JSON.stringify(daysOfWeek)} -> normalized: ${JSON.stringify(normalizedDays)}`);
    console.log(`    todaySelected: ${todaySelected}`);
    
    if (!todaySelected) {
      console.log(`    -> Skipping ${med.name} (not scheduled for ${todayName})`);
      return false; // Not scheduled for today
    }
  } else {
    console.log(`    -> No daysOfWeek specified, assuming all days`);
  }
  
  // Check stock (if empty, only send refill alert - not implemented in this version)
  // For now, we'll send reminders even if stock is low
  
  console.log(`    -> PASSED: Should send reminder today`);
  return true;
}

function parseBottleRecord(bottleStr) {
  if (!bottleStr || typeof bottleStr !== 'string') {
    console.log(`  parseBottleRecord: Invalid input - not a string: ${typeof bottleStr}`);
    return null;
  }
  
  const parts = bottleStr.split('/');
  if (parts.length < 3) {
    console.log(`  parseBottleRecord: Invalid format - not enough parts: ${parts.length}`);
    return null;
  }
  
  const expirationStr = `${parts[0]}/${parts[1]}/${parts[2]}`;
  console.log(`  parseBottleRecord: Parsing expiration date: "${expirationStr}"`);
  
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
  
  if (!expiration.isValid) {
    console.log(`  parseBottleRecord: Could not parse date "${expirationStr}"`);
    return null;
  }
  
  const quantityPart = parts[3];
  const quantity = quantityPart && quantityPart !== 'N/A' ? Number(quantityPart) : null;
  
  console.log(`  parseBottleRecord: Successfully parsed - expiration: ${expiration.toISODate()}, quantity: ${quantity}`);
  return { expiration, quantity };
}

async function getBottleAlertsForUser(uid, nowDateTime = getNowInZone()) {
  const alerts = [];
  const medsSnapshot = await admin.firestore()
    .collection('users')
    .doc(uid)
    .collection('medications')
    .get();

  const threshold = nowDateTime.plus({ days: EXPIRATION_ALERT_DAYS });

  medsSnapshot.forEach(doc => {
    const med = { id: doc.id, ...doc.data() };
    const bottles = Array.isArray(med.bottles)
      ? med.bottles.map(parseBottleRecord).filter(Boolean)
      : [];

    if (bottles.length === 0) {
      return;
    }

    const sorted = bottles.sort((a, b) => a.expiration.toMillis() - b.expiration.toMillis());
    const activeBottle = sorted[0];
    if (!activeBottle) return;

    if (activeBottle.expiration > threshold) {
      return;
    }

    const hasAlternate = sorted.slice(1).some(bottle => bottle.expiration > nowDateTime && (!bottle.quantity || bottle.quantity > 0));
    const expired = activeBottle.expiration <= nowDateTime;
    const dateLabel = activeBottle.expiration.toFormat('MMM d, yyyy');

    alerts.push({
      medName: med.name || 'Medication',
      message: hasAlternate
        ? `${med.name || 'This medication'} ${expired ? 'had a bottle expire' : 'has a bottle expiring'} on ${dateLabel}. Please switch to one of your other bottles.`
        : `${med.name || 'This medication'} ${expired ? 'had a bottle expire' : 'has a bottle expiring'} on ${dateLabel}. Please purchase a new bottle.`,
      canSwitch: hasAlternate
    });
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

  // Calculate the difference between now and target time
  const diffMinutes = nowDateTime.diff(targetDateTime, 'minutes').minutes;
  
  // For advance reminders (negative offset like -60 for 1 hour before):
  // targetDateTime = reminderTime - 60 minutes (e.g., if reminder is 2:00 PM, target is 1:00 PM)
  // We want to send when now is within WINDOW_MINUTES of the target (e.g., between 1:00-1:05 PM)
  // So diffMinutes should be >= 0 (now is at or past target) and < WINDOW_MINUTES (within window)
  
  // For at-time reminders (offset = 0):
  // targetDateTime = reminderTime (e.g., 2:00 PM)
  // We want to send when now is within WINDOW_MINUTES of target (e.g., between 2:00-2:05 PM)
  // So diffMinutes should be >= 0 and < WINDOW_MINUTES
  
  if (offsetMinutes <= 0) {
    // Advance reminders (negative) or at-time (zero)
    // Check if we're within the window after the target time
    if (nowDateTime < targetDateTime) {
      // Too early - haven't reached the target time yet
      console.log(`  -> shouldSendOffsetReminder: Too early for ${reminderTime} [offset=${offsetMinutes}], now=${nowDateTime.toISO()}, target=${targetDateTime.toISO()}`);
      return false;
    }
    const shouldSend = diffMinutes >= 0 && diffMinutes < WINDOW_MINUTES;
    console.log(`  -> shouldSendOffsetReminder: ${reminderTime} [offset=${offsetMinutes}], diff=${diffMinutes.toFixed(1)}min, shouldSend=${shouldSend}, now=${nowDateTime.toFormat('HH:mm')}, target=${targetDateTime.toFormat('HH:mm')}`);
    return shouldSend;
  }

  // For "after" reminders (positive offset) - not used in current system
  if (nowDateTime > targetDateTime) {
    console.log(`  -> shouldSendOffsetReminder: Too late for ${reminderTime} [offset=${offsetMinutes}], now=${nowDateTime.toISO()}, target=${targetDateTime.toISO()}`);
    return false;
  }
  const shouldSend = diffMinutes >= 0 && diffMinutes < WINDOW_MINUTES;
  console.log(`  -> shouldSendOffsetReminder: ${reminderTime} [offset=${offsetMinutes}], diff=${diffMinutes.toFixed(1)}min, shouldSend=${shouldSend}`);
  return shouldSend;
}

function computeTargetDateTime(reminderTime, offsetMinutes, nowDateTime = getNowInZone()) {
  if (!reminderTime) return null;
  const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
  if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) {
    console.warn(`Invalid reminder time string: ${reminderTime}`);
    return null;
  }

  let reminderDateTime = nowDateTime.set({
    hour: reminderHour,
    minute: reminderMinute,
    second: 0,
    millisecond: 0
  });

  if (offsetMinutes >= 0 && reminderDateTime < nowDateTime.minus({ minutes: WINDOW_MINUTES })) {
    reminderDateTime = reminderDateTime.plus({ days: 1 });
  }

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

async function sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts = []) {
  const now = getNowInZone();
  const formattedDate = now.toFormat('EEEE, MMMM d');

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
            ${bottleAlerts.length > 0 ? `
              <div style="margin-top:24px; padding:20px; background:#fff3cd; border:1px solid #ffc107; border-radius:16px;">
                <h3 style="margin:0 0 12px 0; color:#856404; font-size:18px;">⚠️ Bottle Expiration Alerts</h3>
                ${bottleAlerts.map(alert => `
                  <div style="margin-bottom:12px; padding:12px; background:white; border-radius:12px; border:1px solid #ffc107;">
                    <div style="font-weight:600; color:#856404; margin-bottom:4px;">${alert.medName}</div>
                    <div style="color:#856404; font-size:15px;">${alert.message}</div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
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

  const textBottleAlerts = bottleAlerts.length > 0 ? [
    '',
    'BOTTLE EXPIRATION ALERTS:',
    ...bottleAlerts.map(alert => `  ${alert.medName}: ${alert.message}`),
    ''
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
  const subject = missedDoses.length === 1 
    ? `Missed Dose: ${missedDoses[0].med.name}`
    : `Missed Doses: ${missedDoses.length} medications`;
  
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
    const minutesLate = Math.floor(nowDateTime.diff(scheduledDateTime, 'minutes').minutes);
    
    return `
      <div class="med-info">
        <p class="med-name">${med.name}</p>
        <div class="dose-row">
          <span class="dose-chip">${doseLabel}</span>
          <span class="time-badge">${time12}</span>
        </div>
        <div class="detail"><span class="label">Dosage:</span> ${med.dosage || 'N/A'}</div>
        <div class="detail"><span class="label">Scheduled time:</span> ${time12}</div>
        <div class="detail"><span class="label">Time since scheduled:</span> ${minutesLate} minutes</div>
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
            Doses are automatically marked as "Not Taken" if not marked within 45 minutes of the scheduled time.
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
  missedDoses.forEach(({ med, reminderTime, doseNumber, scheduledDateTime }) => {
    const time12 = format12Hour(reminderTime);
    const minutesLate = Math.floor(nowDateTime.diff(scheduledDateTime, 'minutes').minutes);
    textLines.push(`${med.name} - Dose #${doseNumber}`);
    textLines.push(`Scheduled: ${time12}`);
    textLines.push(`Time since scheduled: ${minutesLate} minutes`);
    textLines.push('');
  });
  textLines.push('If this is a mistake and you did take the medication, please update the status in Everane.');
  textLines.push('');
  textLines.push('Everane');
  
  const textBody = textLines.join('\n');
  
  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: userEmail,
    subject,
    text: textBody,
    html: htmlBody
  };
  
  try {
    await transporter.sendMail(mailOptions);
    console.log(`Missed dose email sent to ${userEmail} for ${missedDoses.length} dose(s)`);
  } catch (error) {
    console.error('Error sending missed dose email:', error);
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
async function checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, nowDateTime, db, userPhoneNumber = null, phoneVerified = false) {
  const missedDoses = [];
  const updates = {}; // Track which medications need updates
  
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
      deletedStatus: rawData.deletedStatus === true,
      doses: rawData.doses || {}
    };
    
    // Skip if deleted or not email/SMS reminders (E, S, ES, or Email)
    const isEmailReminder = med.reminderMethod === 'E' || med.reminderMethod === 'ES' || med.reminderMethod === 'Email';
    const isSMSReminder = med.reminderMethod === 'S' || med.reminderMethod === 'ES';
    if (med.deletedStatus || (!isEmailReminder && !isSMSReminder)) {
      continue;
    }
    
    // Check if medication should send reminder today
    if (!shouldSendReminderToday(med, nowDateTime)) {
      continue;
    }
    
    // Determine the current dose (same logic as reminder sending)
    const currentDose = determineCurrentDoseForEmail(med, nowDateTime);
    if (!currentDose) {
      continue; // No current dose found
    }
    
    // Only check the current dose for missed status
    const reminderTime = currentDose.timeStr;
    if (!reminderTime) {
      continue; // No time specified, skip
    }
    
    const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
    if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) {
      continue;
    }
    
    // Calculate scheduled date/time for this dose
    const scheduledDateTime = nowDateTime.set({
      hour: reminderHour,
      minute: reminderMinute,
      second: 0,
      millisecond: 0
    });
    
    // If scheduled time is in the future, skip
    if (scheduledDateTime > nowDateTime) {
      continue;
    }
    
    // Check if 45+ minutes have passed
    const minutesPast = nowDateTime.diff(scheduledDateTime, 'minutes').minutes;
    if (minutesPast < 45) {
      continue; // Not yet 45 minutes past
    }
    
    // Check if dose is already marked
    const todayIso = nowDateTime.toISODate();
    const doseKey = `${todayIso}_${currentDose.doseNumber}`;
    const doseEntry = med.doses[doseKey];
    
    if (doseEntry && (doseEntry.taken === true || doseEntry.taken === false)) {
      continue; // Already marked, skip
    }
    
    // This dose is missed - mark as not taken
    console.log(`[Missed Dose] Marking ${med.name} dose #${currentDose.doseNumber} at ${reminderTime} as not taken (${Math.floor(minutesPast)} minutes late)`);
    
    if (!updates[med.id]) {
      updates[med.id] = {
        medDocRef: db.collection('users').doc(userId).collection('medications').doc(med.id),
        doses: { ...med.doses }
      };
    }
    
    // Mark as not taken
    updates[med.id].doses[doseKey] = {
      date: todayIso,
      doseNumber: currentDose.doseNumber,
      taken: false,
      takenAt: null,
      autoMarked: true // Flag to indicate this was auto-marked
    };
    
    missedDoses.push({
      med,
      reminderTime,
      doseNumber: currentDose.doseNumber,
      scheduledDateTime
    });
  }
  
  // Save all updates to Firebase
  for (const [medId, update] of Object.entries(updates)) {
    try {
      await update.medDocRef.set({
        doses: update.doses
      }, { merge: true });
      console.log(`[Missed Dose] Updated ${update.medDocRef.id} with auto-marked doses`);
    } catch (error) {
      console.error(`[Missed Dose] Error updating ${medId}:`, error);
    }
  }
  
  // Send email if there are missed doses (filter by reminder method)
  const emailMissedDoses = missedDoses.filter(({ med }) => {
    const rm = med.reminderMethod || 'N';
    return rm === 'E' || rm === 'ES' || rm === 'Email';
  });
  if (emailMissedDoses.length > 0) {
    try {
      await sendMissedDoseEmail(userEmail, emailMissedDoses);
    } catch (error) {
      console.error('[Missed Dose] Error sending email:', error);
    }
  }
  
  // Send SMS if there are missed doses and phone is verified (filter by reminder method)
  const smsMissedDoses = missedDoses.filter(({ med }) => {
    const rm = med.reminderMethod || 'N';
    return rm === 'S' || rm === 'ES';
  });
  if (smsMissedDoses.length > 0 && userPhoneNumber && phoneVerified) {
    try {
      await sendMissedDoseSMS(userPhoneNumber, smsMissedDoses);
    } catch (error) {
      console.error('[Missed Dose] Error sending SMS:', error);
    }
  }
}

async function sendCombinedReminderEmail(userEmail, meds, reminderTime, offsetKey = 'at_time', alerts = [], todaysSchedule = [], bottleAlerts = [], userTimezone = null) {
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

  const totalItems = meds.length + alerts.length;
  if (isAtTime) {
    if (totalItems === 1 && meds.length === 1) {
      subject = `Medication Reminder: ${meds[0].name}`;
    } else if (totalItems === 1 && alerts.length === 1) {
      subject = `Everane Alert: ${alerts[0].med.name}`;
    } else {
      subject = `Everane: ${meds.length > 0 ? `${meds.length} Reminder${meds.length > 1 ? 's' : ''}` : ''}${meds.length > 0 && alerts.length > 0 ? ' + ' : ''}${alerts.length > 0 ? `${alerts.length} Alert${alerts.length > 1 ? 's' : ''}` : ''}`;
    }
  } else {
    const snippet = option.subjectSnippet || 'soon';
    subject = meds.length === 1 ? `Upcoming ${snippet} reminder: ${meds[0].name}` : `Upcoming ${snippet} reminders: ${meds.length} medications`;
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

  const bottleAlertsHtml = bottleAlerts.length > 0 ? `
    <div class="section-divider"></div>
    <div class="content-section">
      <h2 class="section-title">Bottle Alerts</h2>
      ${bottleAlerts.map(alert => `
        <div class="alert-info">
          <p class="alert-title">${alert.medName}</p>
          <div>${alert.message}</div>
        </div>
      `).join('')}
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

  const mailOptions = {
    from: `Everane <${gmailEmail}>`,
    to: userEmail,
    subject,
    text: textBody,
    html: htmlBody
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
    
    const result = await transporter.sendMail(mailOptions);
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
 * Sends combined reminder SMS for multiple medications at the same time
 * @param {string} phoneNumber - User's phone number (E.164 format)
 * @param {Array} meds - Array of medication objects
 * @param {string} reminderTime - Time of reminder
 * @param {string} offsetKey - Which reminder preference triggered this SMS
 * @param {Array} alerts - Array of {med, alertType} objects for alerts
 * @param {Array} todaysSchedule - Array of schedule entries for dose number lookup
 * @param {Array} bottleAlerts - Array of bottle alert objects
 * @param {string} userTimezone - User's timezone
 */
async function sendCombinedReminderSMS(phoneNumber, meds, reminderTime, offsetKey = 'at_time', alerts = [], todaysSchedule = [], bottleAlerts = [], userTimezone = null) {
  if (!sinchSmsClient || !sinchPhoneNumber) {
    throw new Error('Sinch not configured - cannot send SMS');
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
    if (isAtTime) {
      // At-time reminders: "Click here to take your {med name} medication: {link}"
      meds.forEach((med, index) => {
        if (med._isAlreadyTaken) {
          return; // Skip already taken medications
        }
        const scheduleEntry = findScheduleEntry(med.id);
        const doseNumber = scheduleEntry ? scheduleEntry.doseNumber : (meds.length > 1 ? index + 1 : 1);
        const scheduledTimeRaw = scheduleEntry && scheduleEntry.time ? scheduleEntry.time : reminderTime;
        const todayIso = nowDateTime.toISODate();
        const link = `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}`;
        messageParts.push(`Click here to take your ${med.name} medication: ${link}`);
      });
    } else {
      // Advance reminders: "Take your {med name} in {minutes} minutes"
      const minutes = Math.abs(option.minutes);
      meds.forEach((med) => {
        if (med._isAlreadyTaken) {
          return; // Skip already taken medications
        }
        messageParts.push(`Take your ${med.name} in ${minutes} minutes`);
      });
    }
  }

  // Add alerts
  if (alerts.length > 0) {
    alerts.forEach(({ med, alertType }) => {
      const alertMsg = alertType === 'noBottles' 
        ? `${med.name}: No bottles entered. Please add bottle information.`
        : `${med.name}: Out of stock. Please refill soon.`;
      messageParts.push(alertMsg);
    });
  }

  // Add bottle alerts
  if (bottleAlerts.length > 0) {
    bottleAlerts.forEach(alert => {
      messageParts.push(`${alert.medName}: ${alert.message}`);
    });
  }

  // Combine into single message (SMS has 160 character limit per message, but can send multiple)
  const fullMessage = messageParts.join('\n\n');
  
  try {
    await sendSMS(phoneNumber, fullMessage);
    console.log(`✅ Combined reminder SMS sent successfully to ${phoneNumber}`);
    console.log(`  Medications: ${meds.length}, Alerts: ${alerts.length}, Bottle Alerts: ${bottleAlerts.length}`);
  } catch (error) {
    console.error('❌ Error sending combined SMS:', error);
    throw error;
  }
}

/**
 * Sends daily agenda SMS
 * @param {string} phoneNumber - User's phone number
 * @param {Array} scheduleEntries - Array of schedule entry objects
 * @param {Array} bottleAlerts - Array of bottle alert objects
 * @param {string} userTimezone - User's timezone
 */
async function sendDailyAgendaSMS(phoneNumber, scheduleEntries, bottleAlerts = [], userTimezone = null) {
  if (!sinchSmsClient || !sinchPhoneNumber) {
    throw new Error('Sinch not configured - cannot send SMS');
  }

  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const formattedDate = nowDateTime.toFormat('MMMM d, yyyy');

  let messageParts = [`Today's Medication Agenda - ${formattedDate}`, ''];

  // Add schedule
  scheduleEntries.forEach(entry => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    const doseLabel = entry.totalDoses > 1 ? `Dose ${entry.doseNumber}` : 'Scheduled dose';
    messageParts.push(`${timeLabel} - ${doseLabel}: ${entry.name}${entry.dosage ? ` (${entry.dosage})` : ''}`);
  });

  // Add bottle alerts
  if (bottleAlerts.length > 0) {
    messageParts.push('');
    messageParts.push('Bottle Alerts:');
    bottleAlerts.forEach(alert => {
      messageParts.push(`${alert.medName}: ${alert.message}`);
    });
  }

  messageParts.push('');
  messageParts.push('Remember to mark each medication as taken in Everane.');

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
async function sendMissedDoseSMS(phoneNumber, missedDoses) {
  if (missedDoses.length === 0) return;
  
  if (!sinchSmsClient || !sinchPhoneNumber) {
    throw new Error('Sinch not configured - cannot send SMS');
  }

  const time12 = format12Hour(missedDoses[0].reminderTime);
  
  let messageParts = [`Missed Dose Alert - ${missedDoses.length} medication${missedDoses.length > 1 ? 's' : ''}`, ''];
  
  missedDoses.forEach(({ med, reminderTime, doseNumber, scheduledDateTime }) => {
    const minutesLate = Math.floor((new Date() - scheduledDateTime.toJSDate()) / (1000 * 60));
    messageParts.push(`${med.name} - Dose #${doseNumber}`);
    messageParts.push(`Scheduled: ${format12Hour(reminderTime)}`);
    messageParts.push(`Missed by: ${minutesLate} minutes`);
    messageParts.push('');
  });

  messageParts.push('Please mark these doses in Everane.');

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
        const todaysSchedule = [];
        const scheduleKeys = new Set();
        
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

          // Comprehensive logging
          console.log(`\n=== Checking medication: ${med.name} ===`);
          console.log(`  ID: ${med.id}`);
          console.log(`  reminderMethod: "${med.reminderMethod}" (type: ${typeof med.reminderMethod})`);
          console.log(`  deletedStatus: ${med.deletedStatus}`);
          console.log(`  daysOfWeek: ${JSON.stringify(med.daysOfWeek)} (length: ${med.daysOfWeek.length})`);
          console.log(`  times: ${JSON.stringify(med.times)} (length: ${med.times.length})`);
          console.log(`  timesPerDay: ${med.timesPerDay}`);
          console.log(`  startDate: "${med.startDate}"`);
          console.log(`  endDate: "${med.endDate}"`);
          console.log(`  bottles: ${JSON.stringify(med.bottles)} (length: ${med.bottles.length})`);
          console.log(`  stock: ${med.stock}`);
          console.log(`  schedules: ${JSON.stringify(med.schedules ? med.schedules.length + ' entries' : 'null')}`);
          
          // Skip if medication is deleted
          if (med.deletedStatus === true) {
            console.log(`  -> SKIPPING: Medication is deleted`);
            continue;
          }
          
          // Check reminder methods - E = Email, S = SMS, ES = Both, N = None
          const isEmailReminder = med.reminderMethod === 'E' || med.reminderMethod === 'ES' || med.reminderMethod === 'Email';
          const isSMSReminder = med.reminderMethod === 'S' || med.reminderMethod === 'ES';
          
          if (!isEmailReminder && !isSMSReminder) {
            console.log(`  -> SKIPPING: Reminder method is "${med.reminderMethod}", not Email or SMS`);
            continue;
          }
          
          console.log(`  -> PASSED: Email=${isEmailReminder}, SMS=${isSMSReminder}`);
          
          // Check for alerts (no bottles or out of stock)
          if (!med.bottles || med.bottles.length === 0) {
            alertMeds.push({ med, alertType: 'noBottles' });
            console.log(`  -> Added to alerts: no bottles`);
          } else if (med.stock === 0) {
            alertMeds.push({ med, alertType: 'outOfStock' });
            console.log(`  -> Added to alerts: out of stock`);
          }
          
          // Check if medication should send reminder today (using user's timezone)
          const shouldSendToday = shouldSendReminderToday(med, userNowDateTime);
          
          if (!shouldSendToday) {
            console.log(`  -> SKIPPING: Not scheduled for today or other conditions not met`);
            console.log(`  -> DEBUG: daysOfWeek=${JSON.stringify(med.daysOfWeek)}, endDate=${med.endDate}, deletedStatus=${med.deletedStatus}`);
            continue;
          }
          
          // Determine the current dose (only send reminders for current dose, not future doses)
          const currentDose = determineCurrentDoseForEmail(med, userNowDateTime);
          if (!currentDose) {
            console.log(`  -> SKIPPING: No current dose found for ${med.name}`);
            console.log(`  -> DEBUG: times=${JSON.stringify(med.times)}, timesPerDay=${med.timesPerDay}, daysOfWeek=${JSON.stringify(med.daysOfWeek)}`);
            continue;
          }
          
          const currentDoseDateLabel = currentDose.dateTime && typeof currentDose.dateTime.toFormat === 'function'
            ? currentDose.dateTime.toFormat('yyyy-MM-dd HH:mm')
            : (currentDose.dateTime instanceof Date ? currentDose.dateTime.toISOString() : String(currentDose.dateTime));
          console.log(`  -> Current dose: ${currentDose.timeStr || currentDose.time || 'any time'}, dose #${currentDose.doseNumber}, scheduled for: ${currentDoseDateLabel}`);
          
          // Check if current dose is already taken
          const todayIsoDate = userNowDateTime.toISODate(); // Format: YYYY-MM-DD
          const doseKey = `${todayIsoDate}_${currentDose.doseNumber}`;
          const doseEntry = med.doses && med.doses[doseKey] ? med.doses[doseKey] : null;
          const isAlreadyTaken = doseEntry && doseEntry.taken === true;
          
          if (isAlreadyTaken) {
            console.log(`  -> Dose already taken (key: ${doseKey})`);
          } else {
            console.log(`  -> Dose not yet taken (key: ${doseKey})`);
          }
          
          // Add to today's schedule for display
          if (med.schedules && med.schedules.length > 0) {
            const doses = ScheduleUtils.getScheduledDosesForDate(med.schedules, userNowDateTime);
            doses.forEach(dose => {
              const key = `${med.id}|${dose.time || 'any'}`;
              if (!scheduleKeys.has(key)) {
                scheduleKeys.add(key);
                todaysSchedule.push({
                  time: dose.time,
                  name: med.name || 'Medication',
                  dosage: med.dosage || null,
                  doseNumber: dose.doseNumber,
                  totalDoses: doses.length,
                  medId: med.id
                });
              }
            });
          } else {
            // Keep existing logic as fallback
            const reminderTimes = getReminderTimes(med);
            const sortedReminderTimes = [...reminderTimes].sort();

            const scheduleTimes = sortedReminderTimes.length > 0 ? sortedReminderTimes : [null];
            scheduleTimes.forEach((timeStr, scheduleIndex) => {
              const key = `${med.id}|${timeStr || 'any'}`;
              if (!scheduleKeys.has(key)) {
                scheduleKeys.add(key);
                todaysSchedule.push({
                  time: timeStr,
                  name: med.name || 'Medication',
                  dosage: med.dosage || null,
                  doseNumber: scheduleTimes.length > 1 && timeStr ? scheduleIndex + 1 : 1,
                  totalDoses: scheduleTimes.length,
                  medId: med.id
                });
              }
            });
          }
          
          // Only send reminders for the CURRENT dose's time
          const reminderTime = currentDose.timeStr;
          if (!reminderTime) {
            // If no time specified, treat as "any time" - only send at-time reminders
            for (const preference of reminderPreferences) {
              if (preference !== 'at_time') continue; // Skip advance reminders for "any time" doses
              
              const option = getReminderOption(preference);
              const targetDateTime = computeTargetDateTime('09:00', option.minutes, userNowDateTime); // Use 9 AM as default
              
              if (!targetDateTime) continue;
              
              const shouldSend = shouldSendOffsetReminder('09:00', option.minutes, userNowDateTime);
              
              if (shouldSend) {
                const reminderKey = `${med.id}|any|${preference}|${todayIso}`;
                if (lastSentReminders[reminderKey]) {
                  console.log(`Skipping ${med.name} [any time, offset=${preference}] - already sent today`);
                  continue;
                }
                
                const groupKey = `${preference}|09:00`;
                if (!sendGroups[groupKey]) {
                  sendGroups[groupKey] = { meds: [], emailMeds: [], smsMeds: [], reminderTime: '09:00', offsetKey: preference, reminderKeys: [] };
                }
                sendGroups[groupKey].meds.push(med);
                sendGroups[groupKey].reminderKeys.push(reminderKey);
                if (isEmailReminder) sendGroups[groupKey].emailMeds.push(med);
                if (isSMSReminder) sendGroups[groupKey].smsMeds.push(med);
                console.log(`Queued ${med.name} for any time [offset=${preference}] (Email: ${isEmailReminder}, SMS: ${isSMSReminder})`);
              }
            }
            continue;
          }
          
          // Validate reminder time
          const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
          if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) {
            console.warn(`Skipping invalid reminder time "${reminderTime}" for ${med.name}`);
            continue;
          }
          
          // Send reminders only for the current dose's time
          for (const preference of reminderPreferences) {
            // If dose is already taken, skip all advance reminders
            // Only send "already taken" email at the actual time
            if (isAlreadyTaken && preference !== 'at_time') {
              console.log(`  -> Skipping ${preference} reminder for ${med.name} - dose already taken`);
              continue;
            }
            
            const option = getReminderOption(preference);
            const targetDateTime = computeTargetDateTime(reminderTime, option.minutes, userNowDateTime);
            
            if (!targetDateTime) {
              console.log(`  -> Skipping ${preference} reminder for ${med.name} - invalid targetDateTime`);
              continue;
            }
            
            const shouldSend = shouldSendOffsetReminder(reminderTime, option.minutes, userNowDateTime);
            console.log(`  -> Checking ${preference} reminder for ${med.name} at ${reminderTime}: shouldSend=${shouldSend}, offset=${option.minutes}min, now=${userNowDateTime.toFormat('HH:mm')}, target=${targetDateTime.toFormat('HH:mm')}`);
            
            if (shouldSend) {
              // Check if we've already sent this reminder today
              const reminderKey = `${med.id}|${reminderTime}|${preference}|${todayIso}`;
              if (lastSentReminders[reminderKey]) {
                console.log(`  -> Skipping ${med.name} at ${reminderTime} [offset=${preference}] - already sent today`);
                continue;
              }
              
              // Mark medication as already taken for at_time reminders
              const medWithTakenStatus = { ...med, _isAlreadyTaken: isAlreadyTaken };
              
              const groupKey = `${preference}|${reminderTime}`;
              if (!sendGroups[groupKey]) {
                sendGroups[groupKey] = { meds: [], emailMeds: [], smsMeds: [], reminderTime, offsetKey: preference, reminderKeys: [] };
              }
              sendGroups[groupKey].meds.push(medWithTakenStatus);
              sendGroups[groupKey].reminderKeys.push(reminderKey);
              if (isEmailReminder) sendGroups[groupKey].emailMeds.push(medWithTakenStatus);
              if (isSMSReminder) sendGroups[groupKey].smsMeds.push(medWithTakenStatus);
              console.log(`  -> Queued ${med.name} for ${reminderTime} [offset=${preference}] (Email: ${isEmailReminder}, SMS: ${isSMSReminder}${isAlreadyTaken ? ', already taken' : ''})`);
            }
          }
        }
        
        // Send grouped emails and SMS (include alerts if offset is at_time at 09:00)
        let sentAtTimeNineAM = false;
        console.log(`\n=== EMAIL & SMS SENDING PHASE ===`);
        console.log(`Total send groups: ${Object.keys(sendGroups).length}`);
        console.log(`User phone: ${userPhoneNumber}, Verified: ${phoneVerified}`);
        
        for (const [groupKey, group] of Object.entries(sendGroups)) {
          if (!group || group.meds.length === 0) {
            console.log(`Skipping empty group: ${groupKey}`);
            continue;
          }
          
          const includeAlerts = group.offsetKey === 'at_time' && group.reminderTime === '09:00' ? alertMeds : [];
          if (includeAlerts.length > 0) {
            sentAtTimeNineAM = true;
          }
          
          // Get bottle alerts for this user
          const bottleAlerts = await getBottleAlertsForUser(userId, userNowDateTime);
          
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
              
              console.log(`✅ SUCCESS: Email sent to ${userEmail} for ${group.emailMeds.length} medications at ${group.reminderTime} [offset=${group.offsetKey}]`);
            } catch (error) {
              console.error(`❌ FAILED to send reminder email to ${userEmail} for ${group.reminderTime} [offset=${group.offsetKey}]:`, error);
              console.error(`  Error details:`, error.message);
              // Continue with SMS even if email fails
            }
          }
          
          // Send SMS reminders
          if (group.smsMeds && group.smsMeds.length > 0) {
            if (!userPhoneNumber || !phoneVerified) {
              console.log(`  -> Skipping SMS: Phone number ${userPhoneNumber ? 'not verified' : 'not provided'}`);
            } else {
              try {
                console.log(`\n>>> ATTEMPTING TO SEND SMS <<<`);
                console.log(`  Group key: ${groupKey}`);
                console.log(`  SMS medications: ${group.smsMeds.length}`);
                console.log(`  Reminder time: ${group.reminderTime}`);
                console.log(`  Offset: ${group.offsetKey}`);
                console.log(`  User phone: ${userPhoneNumber}`);
                
                await sendCombinedReminderSMS(userPhoneNumber, group.smsMeds, group.reminderTime, group.offsetKey, includeAlerts, todaysSchedule, bottleAlerts, userTimezone);
                
                console.log(`✅ SUCCESS: SMS sent to ${userPhoneNumber} for ${group.smsMeds.length} medications at ${group.reminderTime} [offset=${group.offsetKey}]`);
              } catch (error) {
                console.error(`❌ FAILED to send reminder SMS to ${userPhoneNumber} for ${group.reminderTime} [offset=${group.offsetKey}]:`, error);
                console.error(`  Error details:`, error.message);
                // Continue with other groups even if SMS fails
              }
            }
          }
          
          // Mark reminders as sent to prevent duplicates (only if at least one was sent successfully)
          if (group.reminderKeys) {
            group.reminderKeys.forEach(key => {
              lastSentReminders[key] = userNowDateTime.toISO();
              console.log(`  Marked reminder as sent: ${key}`);
            });
          }
        }
        
        if (Object.keys(sendGroups).length === 0) {
          console.log(`No emails to send - no send groups created`);
        }
        
        // Update lastSentReminders in user document
        if (Object.keys(lastSentReminders).length > 0) {
          try {
            // Clean up old entries (older than 2 days)
            const twoDaysAgo = userNowDateTime.minus({ days: 2 }).toISODate();
            Object.keys(lastSentReminders).forEach(key => {
              const keyDate = key.split('|')[3]; // Extract date from key
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
        
        // If it's around 9 AM and we have alerts but no at-time reminders, send alerts-only email
        if (!sentAtTimeNineAM && alertMeds.length > 0 && shouldSendOffsetReminder('09:00', REMINDER_OPTIONS.at_time.minutes, userNowDateTime)) {
          try {
            console.log(`Sending alerts-only email for ${alertMeds.length} medications at 09:00`);
            const bottleAlerts = await getBottleAlertsForUser(userId, userNowDateTime);
            await sendCombinedReminderEmail(userEmail, [], '09:00', 'at_time', alertMeds, todaysSchedule, bottleAlerts, userTimezone);
          } catch (error) {
            console.error(`Failed to send alerts-only email to ${userEmail}:`, error);
          }
        }
        
        // Check for missed doses (45+ minutes past scheduled time, not marked)
        try {
          await checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, userNowDateTime, db, userPhoneNumber, phoneVerified);
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
        console.log(`  Alerts found: ${alertMeds.length}`);
        console.log(`  Emails queued: ${Object.values(sendGroups).reduce((sum, g) => sum + (g.meds ? g.meds.length : 0), 0)}`);
        console.log(`===================================\n`);
      } catch (error) {
        console.error(`❌ Error processing reminders for user ${userId} (${userEmail}):`, error);
        console.error(`  Error stack:`, error.stack);
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
      
      // Only send agenda if it's 9:00 AM in the user's timezone (within 5-minute window)
      const currentHour = userNow.hour;
      const currentMinute = userNow.minute;
      if (currentHour !== 9 || currentMinute > 4) {
        // Not 9:00-9:04 AM in user's timezone, skip
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
        
        // Send email agenda (always send if user has email)
        await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts);
        
        // Send SMS agenda if phone is verified
        if (userPhoneNumber && phoneVerified) {
          try {
            await sendDailyAgendaSMS(userPhoneNumber, scheduleEntries, bottleAlerts, userTimezone);
            console.log(`Daily agenda SMS sent to ${userPhoneNumber} at 9:00 AM ${userTimezone}`);
          } catch (error) {
            console.error(`Failed to send daily agenda SMS for ${userPhoneNumber}`, error);
            // Continue even if SMS fails
          }
        }
        
        await userDoc.ref.set({ lastAgendaSentDate: todayIso }, { merge: true });
        console.log(`Daily agenda sent to ${userEmail} at 9:00 AM ${userTimezone}`);
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
  await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts);
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
  ADHERENCE_BELOW_80: 'adherence_below_80'
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

      await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
      await markCaregiverEmailSent(db, caregiverId, todayKey);
      console.log(`[Caregiver Emails] Sent expiration digest to ${caregiverEmail} (${caregiverId})`);
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

      await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
      await markCaregiverEmailSent(db, caregiverId, todayKey);
      console.log(`[Caregiver Emails] Sent adherence<80 alert to ${caregiverEmail} (${caregiverId})`);
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

      await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
      await markCaregiverEmailSent(db, caregiverId, weekKey);
      console.log(`[Caregiver Emails] Sent weekly report to ${caregiverEmail} (${caregiverId})`);
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

      await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
      await markCaregiverEmailSent(db, caregiverId, monthKey);
      console.log(`[Caregiver Emails] Sent monthly report to ${caregiverEmail} (${caregiverId})`);
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
 * Send phone verification code via Sinch SMS API
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
      console.log('📱 sendPhoneVerificationCode called (Sinch SMS)');
      console.log('  Phone number:', phoneNumber);

      if (!phoneNumber) {
        res.status(400).json({ error: 'Phone number is required' });
        return;
      }

      if (!sinchSmsClient || !sinchPhoneNumber) {
        console.error('❌ Sinch SMS client not initialized!');
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

      // Send via Sinch SMS
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

      // Create ephemeral Realtime client secret (GA endpoint — matches /v1/realtime/calls on client)
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
            audio: {
              output: { voice: 'verse' },
            },
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

