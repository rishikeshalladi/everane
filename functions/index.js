/**
 * Firebase Cloud Functions for MedTracker Email Reminders
 * 
 * This function runs on a schedule (every hour) and checks which medications
 * need reminders sent based on the user's settings.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');

admin.initializeApp();

// Configure your email service (Gmail example)
// For production, use environment config: firebase functions:config:set gmail.email="your@gmail.com" gmail.password="your-app-password"
const gmailEmail = functions.config().gmail?.email || process.env.GMAIL_EMAIL;
const gmailPassword = functions.config().gmail?.password || process.env.GMAIL_PASSWORD;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: gmailEmail,
    pass: gmailPassword // Use App Password, not regular password
  }
});

/**
 * Determines reminder times based on medication settings
 * @param {Object} med - Medication object
 * @returns {Array} - Array of time strings in HH:MM format
 */
function getReminderTimes(med) {
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
const TIME_ZONE = 'America/Los_Angeles';
const WINDOW_MINUTES = 5; // Increased from 1 to 5 to ensure we don't miss reminders
const EXPIRATION_ALERT_DAYS = 7;

function getNowInZone() {
  return DateTime.now().setZone(TIME_ZONE);
}

function parseEndDate(dateStr) {
  if (!dateStr || dateStr === 'N/A') return null;
  const parsed = DateTime.fromFormat(dateStr, 'M/d/yyyy', { zone: TIME_ZONE });
  if (parsed.isValid) {
    return parsed.endOf('day');
  }
  const isoParsed = DateTime.fromISO(dateStr, { zone: TIME_ZONE });
  return isoParsed.isValid ? isoParsed.endOf('day') : null;
}

function shouldSendReminderToday(med, nowDateTime = getNowInZone()) {
  const weekdayIndex = nowDateTime.weekday % 7; // Luxon weekday: Monday=1 ... Sunday=7 -> convert to 0-based Sunday
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = weekdays[weekdayIndex];
  
  // Check if medication is deleted
  if (med.deletedStatus === true) {
    console.log(`  -> Skipping ${med.name} (deleted)`);
    return false;
  }
  
  // Check if end date has passed
  const endDate = parseEndDate(med.endDate);
  if (endDate && nowDateTime > endDate) {
    console.log(`  -> Skipping ${med.name} (end date ${endDate.toISODate()} has passed, now ${nowDateTime.toISODate()})`);
    return false;
  }
  
  // Check if today is in the selected days
  if (med.daysOfWeek && med.daysOfWeek.length > 0) {
    const todaySelected = med.daysOfWeek.some(day => 
      day.toLowerCase() === todayName
    );
    if (!todaySelected) {
      console.log(`  -> Skipping ${med.name} (not scheduled for ${todayName})`);
      return false; // Not scheduled for today
    }
  }
  
  // Check stock (if empty, only send refill alert - not implemented in this version)
  // For now, we'll send reminders even if stock is low
  
  return true;
}

function parseBottleRecord(bottleStr) {
  if (!bottleStr || typeof bottleStr !== 'string') return null;
  const parts = bottleStr.split('/');
  if (parts.length < 3) return null;
  const expirationStr = `${parts[0]}/${parts[1]}/${parts[2]}`;
  const expiration = DateTime.fromFormat(expirationStr, 'M/d/yyyy', { zone: TIME_ZONE });
  if (!expiration.isValid) return null;
  const quantityPart = parts[3];
  const quantity = quantityPart && quantityPart !== 'N/A' ? Number(quantityPart) : null;
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

function shouldSendOffsetReminder(reminderTime, offsetMinutes, nowDateTime = getNowInZone()) {
  if (!reminderTime) return false;
  const targetDateTime = computeTargetDateTime(reminderTime, offsetMinutes, nowDateTime);
  if (!targetDateTime) {
    console.log(`  -> shouldSendOffsetReminder: Invalid targetDateTime for ${reminderTime} with offset ${offsetMinutes}`);
    return false;
  }

  if (offsetMinutes <= 0) {
    // For "at time" or "before" reminders (negative or zero offset)
    if (nowDateTime < targetDateTime) {
      console.log(`  -> shouldSendOffsetReminder: Too early for ${reminderTime} [offset=${offsetMinutes}], now=${nowDateTime.toISO()}, target=${targetDateTime.toISO()}`);
      return false;
    }
    const diffMinutes = nowDateTime.diff(targetDateTime, 'minutes').minutes;
    const shouldSend = diffMinutes >= 0 && diffMinutes < WINDOW_MINUTES;
    console.log(`  -> shouldSendOffsetReminder: ${reminderTime} [offset=${offsetMinutes}], diff=${diffMinutes.toFixed(1)}min, shouldSend=${shouldSend}`);
    return shouldSend;
  }

  // For "after" reminders (positive offset) - not used in current system
  if (nowDateTime > targetDateTime) {
    console.log(`  -> shouldSendOffsetReminder: Too late for ${reminderTime} [offset=${offsetMinutes}], now=${nowDateTime.toISO()}, target=${targetDateTime.toISO()}`);
    return false;
  }
  const diffMinutes = targetDateTime.diff(nowDateTime, 'minutes').minutes;
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
            <p style="margin-top:24px;">This agenda includes every dose scheduled for today. Tap “Taken” in MedTracker after each medication so we can keep your history up to date.</p>
            <a href="http://localhost:8000/home.html" class="cta">Open MedTracker</a>
          </div>
          <div class="footer">
            This is an automated message from MedTracker.<br/>You can update reminder preferences anytime from your profile.
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

  const textBody = [
    `Today’s Medication Agenda – ${formattedDate}`,
    '',
    textSchedule,
    '',
    'This agenda includes every dose scheduled for today. Remember to mark each medication as taken inside MedTracker after you complete it.',
    '',
    'MedTracker'
  ].join('\n');

  const mailOptions = {
    from: `MedTracker <${gmailEmail}>`,
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
async function sendCombinedReminderEmail(userEmail, meds, reminderTime, offsetKey = 'at_time', alerts = [], todaysSchedule = []) {
  const time12 = format12Hour(reminderTime);
  const option = getReminderOption(offsetKey);
  const isAtTime = offsetKey === 'at_time';
  const nowDateTime = getNowInZone();
  const todayIndex = nowDateTime.weekday % 7;
  const weekdaysConst = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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
      subject = `MedTracker Alert: ${alerts[0].med.name}`;
    } else {
      subject = `MedTracker: ${meds.length > 0 ? `${meds.length} Reminder${meds.length > 1 ? 's' : ''}` : ''}${meds.length > 0 && alerts.length > 0 ? ' + ' : ''}${alerts.length > 0 ? `${alerts.length} Alert${alerts.length > 1 ? 's' : ''}` : ''}`;
    }
  } else {
    const snippet = option.subjectSnippet || 'soon';
    subject = meds.length === 1 ? `Upcoming ${snippet} reminder: ${meds[0].name}` : `Upcoming ${snippet} reminders: ${meds.length} medications`;
  }

  const headerTitle = isAtTime
    ? `Medication ${totalItems > 1 ? 'Reminders' : 'Reminder'}${alerts.length > 0 ? ' & Alerts' : ''}`
    : `Upcoming Medication Reminder${meds.length > 1 ? 's' : ''}`;
  const headerSubtitle = isAtTime
    ? (meds.length > 0 ? `It’s time to take your medication${meds.length > 1 ? 's' : ''}.` : 'Please review the following alerts.')
    : option.headerLine || 'Here’s your upcoming medication schedule.';

  const medSections = meds.map((med, index) => {
    const scheduleEntry = findScheduleEntry(med.id);
    const doseLabel = scheduleEntry
      ? `Dose ${scheduleEntry.doseNumber}`
      : (meds.length > 1 ? `Dose ${index + 1}` : 'Scheduled dose');
    const scheduledTime = scheduleEntry && scheduleEntry.time
      ? format12Hour(scheduleEntry.time)
      : time12;

    if (isAtTime) {
      addTodaysText(`${doseLabel}: ${scheduledTime} – ${med.name}`);
    }

    return `
      <div class="med-info">
        <p class="med-name">${med.name}</p>
        <div class="dose-row">
          <span class="dose-chip">${doseLabel}</span>
          <span class="time-badge">${scheduledTime}</span>
        </div>
        <div class="detail"><span class="label">Dosage:</span> ${med.dosage || 'N/A'}</div>
        <div class="detail"><span class="label">Reminder time:</span> ${scheduledTime}</div>
        ${med.stock ? `<div class="detail"><span class="label">Bottles in stock:</span> ${med.stock}</div>` : ''}
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
          const displayTime = entry.time ? format12Hour(entry.time) : 'Any time';
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
    closingHtmlLine = `<p class="closing-note">✅ Please tap “Taken” in MedTracker after each dose so we can keep your history up to date.</p>`;
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
          </div>
          <div class="content">
            ${remindersSection || '<div class="content-section"><p>No reminders to show.</p></div>'}
            ${alertsHtml}
            ${closingHtmlLine}
            ${todaysScheduleHtml}
            ${bottleAlertsHtml}
            <div class="cta-wrap">
              <a class="cta" href="http://localhost:8000/home.html">Open MedTracker</a>
            </div>
          </div>
          <div class="footer">
            This is an automated reminder from MedTracker.<br/>
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
      textLines.push(`${doseLabel}: ${med.name}`);
      textLines.push(`Time: ${time12}`);
      if (med.dosage) textLines.push(`Dosage: ${med.dosage}`);
      textLines.push('Instructions: Take with water unless directed otherwise.');
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
  textLines.push('MedTracker');

  const textBody = textLines.join('\n');

  const mailOptions = {
    from: `MedTracker <${gmailEmail}>`,
    to: userEmail,
    subject,
    text: textBody,
    html: htmlBody
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Combined reminder email sent to ${userEmail} (${meds.length} reminders, ${alerts.length} alerts) [offset=${offsetKey}]`);
  } catch (error) {
    console.error('Error sending combined email:', error);
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
          
          ${isAdvance ? '<p>⏰ This is a 30-minute advance reminder. You\'ll receive another reminder at the scheduled time.</p>' : '<p>✅ Remember to mark this dose as taken in your MedTracker app!</p>'}
          
          <p style="text-align: center; margin-top: 30px;">
            <a href="http://localhost:8000/home.html" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block;">Open MedTracker</a>
          </p>
        </div>
        <div class="footer">
          <p>This is an automated reminder from MedTracker</p>
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

MedTracker
  `;
  
  const mailOptions = {
    from: `MedTracker <${gmailEmail}>`,
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
  .timeZone('America/Los_Angeles') // Seattle - Pacific Time
  .onRun(async (context) => {
    console.log('Starting medication reminder check...');
    console.log('Current time:', new Date().toISOString());
    const nowDateTime = getNowInZone();
    console.log('Current Pacific time:', nowDateTime.toISO());
    
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
        
        // Get all medications for this user (we'll filter deleted ones in code)
        const medicationsSnapshot = await db
          .collection('users')
          .doc(userId)
          .collection('medications')
          .get();
        
        console.log(`Found ${medicationsSnapshot.size} active medications for user ${userId}`);
        
        // Determine reminder preferences from profile with defaults
        const rawPreferences = Array.isArray(userData.notification_reminders) ? userData.notification_reminders : [];
        let reminderPreferences = Array.from(new Set(rawPreferences.filter(pref => REMINDER_OPTIONS[pref])));
        if (reminderPreferences.length === 0) {
          reminderPreferences = ['30_minutes_before', 'at_time'];
        }
        console.log(`Reminder preferences for ${userId}: ${JSON.stringify(reminderPreferences)}`);
        
        // Get last sent reminders to prevent duplicates
        const lastSentReminders = userData.lastSentReminders || {};
        const todayIso = nowDateTime.toISODate();

        // Group medications by actual send window (preference + time)
        const sendGroups = {}; // key => { meds: [], reminderTime, offsetKey }
        const alertMeds = []; // Medications with alerts (no bottles, out of stock, etc.)
        const todaysSchedule = [];
        const scheduleKeys = new Set();
        
        for (const medDoc of medicationsSnapshot.docs) {
          const med = { id: medDoc.id, ...medDoc.data() };
          
          console.log(`Checking medication: ${med.name}, reminderMethod: ${med.reminderMethod}, deletedStatus: ${med.deletedStatus}`);
        console.log(`  Raw daysOfWeek: ${JSON.stringify(med.daysOfWeek || med.days)}`);
        console.log(`  Raw times: ${JSON.stringify(med.times)}`);
        console.log(`  timesPerDay: ${med.timesPerDay}, reminderMethod: ${med.reminderMethod}`);
          
          // Skip if medication is deleted
          if (med.deletedStatus === true) {
            console.log(`Skipping ${med.name} - medication is deleted`);
            continue;
          }
          
          // Skip if reminder method is not Email
          if (med.reminderMethod !== 'E') {
            console.log(`Skipping ${med.name} - reminder method is not Email`);
            continue;
          }
          
          // Check for alerts (no bottles or out of stock)
          if (!med.bottles || med.bottles.length === 0) {
            alertMeds.push({ med, alertType: 'noBottles' });
          } else if (med.stock === 0) {
            alertMeds.push({ med, alertType: 'outOfStock' });
          }
          
          // Check if medication should send reminder today
          const shouldSend = shouldSendReminderToday(med, nowDateTime);
          console.log(`Should send reminder for ${med.name} today? ${shouldSend}`);
          
          if (!shouldSend) {
            continue;
          }
          
          // Get reminder times for this medication
          const reminderTimes = getReminderTimes(med);
          console.log(`Reminder times for ${med.name}: ${JSON.stringify(reminderTimes)}`);
          const sortedReminderTimes = [...reminderTimes].sort();
          let previousDoseDateTime = null;

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

          for (const reminderTime of sortedReminderTimes) {
            const [reminderHour, reminderMinute] = reminderTime.split(':').map(Number);
            if (Number.isNaN(reminderHour) || Number.isNaN(reminderMinute)) {
              console.warn(`Skipping invalid reminder time "${reminderTime}" for ${med.name}`);
              continue;
            }
            
            const doseDateTime = nowDateTime.set({
              hour: reminderHour,
              minute: reminderMinute,
              second: 0,
              millisecond: 0
            });
            
            for (const preference of reminderPreferences) {
              const option = getReminderOption(preference);
              const targetDateTime = computeTargetDateTime(reminderTime, option.minutes, nowDateTime);
              
              if (!targetDateTime) {
                continue;
              }
              
              if (previousDoseDateTime) {
                const previousDoseDayStart = previousDoseDateTime.startOf('day');
                if (targetDateTime >= previousDoseDayStart && targetDateTime <= previousDoseDateTime) {
                  console.log(`Skipping ${med.name} at ${reminderTime} [offset=${preference}] because target ${targetDateTime.toISO()} overlaps previous dose at ${previousDoseDateTime.toISO()}`);
                  continue;
                }
              }
              
              const shouldSend = shouldSendOffsetReminder(reminderTime, option.minutes, nowDateTime);
              
              if (shouldSend) {
                // Check if we've already sent this reminder today
                const reminderKey = `${med.id}|${reminderTime}|${preference}|${todayIso}`;
                if (lastSentReminders[reminderKey]) {
                  console.log(`Skipping ${med.name} at ${reminderTime} [offset=${preference}] - already sent today`);
                  continue;
                }
                
                const groupKey = `${preference}|${reminderTime}`;
                if (!sendGroups[groupKey]) {
                  sendGroups[groupKey] = { meds: [], reminderTime, offsetKey: preference, reminderKeys: [] };
                }
                sendGroups[groupKey].meds.push(med);
                sendGroups[groupKey].reminderKeys.push(reminderKey);
                console.log(`Queued ${med.name} for ${reminderTime} [offset=${preference}]`);
              }
            }
            
            if (!previousDoseDateTime || doseDateTime > previousDoseDateTime) {
              previousDoseDateTime = doseDateTime;
            }
          }
        }
        
        // Send grouped emails (include alerts if offset is at_time at 09:00)
        let sentAtTimeNineAM = false;
        for (const group of Object.values(sendGroups)) {
          if (!group || group.meds.length === 0) {
            continue;
          }
          
          const includeAlerts = group.offsetKey === 'at_time' && group.reminderTime === '09:00' ? alertMeds : [];
          if (includeAlerts.length > 0) {
            sentAtTimeNineAM = true;
          }
          
          console.log(`Sending combined reminder email for ${group.meds.length} medications at ${group.reminderTime} [offset=${group.offsetKey}]${includeAlerts.length > 0 ? ` (with ${includeAlerts.length} alerts)` : ''}`);
          await sendCombinedReminderEmail(userEmail, group.meds, group.reminderTime, group.offsetKey, includeAlerts, todaysSchedule);
          
          // Mark reminders as sent to prevent duplicates
          if (group.reminderKeys) {
            group.reminderKeys.forEach(key => {
              lastSentReminders[key] = nowDateTime.toISO();
            });
          }
        }
        
        // Update lastSentReminders in user document
        if (Object.keys(lastSentReminders).length > 0) {
          // Clean up old entries (older than 2 days)
          const twoDaysAgo = nowDateTime.minus({ days: 2 }).toISODate();
          Object.keys(lastSentReminders).forEach(key => {
            const keyDate = key.split('|')[3]; // Extract date from key
            if (keyDate && keyDate < twoDaysAgo) {
              delete lastSentReminders[key];
            }
          });
          
          await db.collection('users').doc(userId).set({
            lastSentReminders: lastSentReminders
          }, { merge: true });
        }
        
        // If it's around 9 AM and we have alerts but no at-time reminders, send alerts-only email
        if (!sentAtTimeNineAM && alertMeds.length > 0 && shouldSendOffsetReminder('09:00', REMINDER_OPTIONS.at_time.minutes, nowDateTime)) {
          console.log(`Sending alerts-only email for ${alertMeds.length} medications at 09:00`);
          await sendCombinedReminderEmail(userEmail, [], '09:00', 'at_time', alertMeds, todaysSchedule);
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
  .schedule('0 9 * * *')
  .timeZone(TIME_ZONE)
  .onRun(async (context) => {
    console.log('sendDailyAgenda: Function started');
    const now = getNowInZone();
    const todayIso = now.toISODate();
    console.log(`sendDailyAgenda: Current date is ${todayIso}, time is ${now.toISO()}`);
    const usersSnapshot = await admin.firestore().collection('users').get();
    console.log(`sendDailyAgenda: Found ${usersSnapshot.size} users`);

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const userEmail = userData.email;
      if (!userEmail) {
        continue;
      }

      if (userData.lastAgendaSentDate === todayIso) {
        console.log(`Agenda already sent today for ${userEmail}, skipping`);
        continue;
      }

      try {
        const scheduleEntries = await buildTodaysSchedule(userDoc.id, now);
        if (!scheduleEntries.length) {
          console.log(`No schedule entries for ${userEmail} today, skipping`);
          continue;
        }

        const bottleAlerts = await getBottleAlertsForUser(userDoc.id, now);
        await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts);
        await userDoc.ref.set({ lastAgendaSentDate: todayIso }, { merge: true });
        console.log(`Daily agenda sent to ${userEmail}`);
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

  const userEmail = userDoc.data().email;
  if (!userEmail) {
    throw new functions.https.HttpsError('failed-precondition', 'Please add an email address to your profile before sending your agenda.');
  }

  const now = getNowInZone();
  const scheduleEntries = await buildTodaysSchedule(uid, now);
  if (!scheduleEntries.length) {
    throw new functions.https.HttpsError('not-found', 'No medications scheduled for today.');
  }

  const bottleAlerts = await getBottleAlertsForUser(uid, now);
  await sendAgendaSummaryEmail(userEmail, scheduleEntries, bottleAlerts);
  await userRef.set({ lastAgendaSentDate: now.toISODate() }, { merge: true });

  return { status: 'success' };
});

