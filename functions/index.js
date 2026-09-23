
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');
const twilio = require('twilio');
const webpush = require('web-push');
const cors = require('cors')({ origin: true });
const crypto = require('crypto');
const ScheduleUtils = require('./schedule-utils');

admin.initializeApp();

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

const gmailEmail = functions.config().gmail?.email || process.env.GMAIL_EMAIL;
const gmailPassword = functions.config().gmail?.password || process.env.GMAIL_PASSWORD;

const APP_BASE_URL = functions.config().app?.baseurl || process.env.APP_BASE_URL || 'https://everane.live';

const twilioAccountSid = functions.config().twilio?.account_sid || process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = functions.config().twilio?.auth_token || process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = functions.config().twilio?.from_number || process.env.TWILIO_FROM_NUMBER;
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
    pass: gmailPassword
  }
});

const doctorSessionSecret =
  functions.config().doctor?.session_secret ||
  process.env.DOCTOR_SESSION_SECRET ||
  (gmailPassword
    ? crypto.createHash('sha256').update('everane-doctor-session:' + gmailPassword).digest('hex')
    : null);

if (!functions.config().doctor?.session_secret && !process.env.DOCTOR_SESSION_SECRET) {
  console.warn('⚠️ doctor.session_secret not configured — falling back to a derived key. Set it with: firebase functions:config:set doctor.session_secret="<random 32+ chars>"');
}

const DOCTOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function issueDoctorToken(uid) {
  if (!doctorSessionSecret) return null;
  const payload = b64url(JSON.stringify({ uid, exp: Date.now() + DOCTOR_SESSION_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', doctorSessionSecret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyDoctorToken(token) {
  if (!doctorSessionSecret || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', doctorSessionSecret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data || !data.uid || typeof data.exp !== 'number') return null;
    if (Date.now() > data.exp) return null;
    return data.uid;
  } catch (_) {
    return null;
  }
}

function requireDoctorSession(req) {
  const authHeader = req.headers.authorization || '';
  const token =
    (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '') ||
    (req.body && typeof req.body.doctorToken === 'string' ? req.body.doctorToken : '');
  return verifyDoctorToken(token);
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHeader(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

transporter.verify(function(error, success) {
  if (error) {
    console.error('❌ EMAIL TRANSPORTER VERIFICATION FAILED:', error);
  } else {
    console.log('✅ Email transporter verified successfully');
  }
});

async function generateUniquePatientId(db) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = String(Math.floor(1000000 + Math.random() * 9000000));
    const snap = await db.collection('users').where('patientId', '==', id).limit(1).get();
    if (snap.empty) return id;
  }
  return String(Date.now()).slice(-7);
}

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
    if (msg && !msg.id) {
      try { msg.id = msg.sid; } catch (_) {}
    }
    return msg;
  }, 3, 750);
}

async function getSmsDeliveryStatus(messageSid, recipient) {
  if (!twilioClient || !messageSid) return null;
  try {
    const m = await twilioClient.messages(messageSid).fetch();
    return {
      status: m.status,
      code: m.errorCode || null,
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


async function recordSendAttempt(db, userId, attempt) {
  try {
    const now = Date.now();
    const id = `${now}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      ts: new Date(now).toISOString(),
      channel: attempt.channel || 'unknown',
      medId: attempt.medId || null,
      medName: attempt.medName || null,
      doseNumber: attempt.doseNumber || null,
      doseTime: attempt.doseTime || null,
      offsetKey: attempt.offsetKey || null,
      date: attempt.date || null,
      status: attempt.status || 'unknown',
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
  let malformed = 0;
  const outcomes = [];
  const providerOf = (url) => {
    try {
      const h = new URL(url).hostname;
      if (/googleapis\.com$/.test(h)) return 'chrome/android';
      if (/push\.apple\.com$/.test(h)) return 'safari/ios';
      if (/mozilla\.com$/.test(h)) return 'firefox';
      if (/windows\.com$/.test(h)) return 'edge';
      return h;
    } catch (_) { return 'unknown'; }
  };
  for (const sub of subscriptions) {
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      // Previously skipped silently: never sent, never pruned, never logged,
      // yet still counted toward the device total shown in the profile panel.
      malformed++;
      outcomes.push('malformed');
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        body,
        {
          urgency: 'high',
          TTL: 60 * 60,
          headers: {
            Urgency: 'high'
          }
        }
      );
      stillValid.push(sub);
      sent++;
      outcomes.push(`${providerOf(sub.endpoint)}:ok`);
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        console.log(`[Push] Pruning dead subscription (${status}) for user ${userId}`);
        dead.push(sub.endpoint);
        outcomes.push(`${providerOf(sub.endpoint)}:gone(${status})`);
      } else {
        console.warn(`[Push] sendNotification failed (${status || '?'}):`, err.message || err);
        stillValid.push(sub);
        outcomes.push(`${providerOf(sub.endpoint)}:err(${status || '?'})`);
      }
    }
  }

  console.log(`[Push] devices=${subscriptions.length} accepted=${sent} malformed=${malformed} pruned=${dead.length} [${outcomes.join(', ')}]`);
  if (malformed > 0) {
    console.warn(`[Push] ${malformed} stored subscription(s) are malformed and can never receive a notification`);
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
  return { sent, pruned: dead.length, malformed, total: subscriptions.length };
}

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

  const showActions = isAtTime && !med._isAlreadyTaken;

  return {
    title,
    body: bodyLines.join('\n'),
    tag: `rem-${todayIso}-${reminderTime}-${offsetKey}-${med.id || name}-d${doseNumber}`,
    requireInteraction: showActions,
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

function getReminderTimes(med, nowDateTime) {
  if (med.schedules && med.schedules.length > 0) {
    const now = nowDateTime || getNowInZone();
    const doses = ScheduleUtils.getScheduledDosesForDate(med.schedules, now);
    const times = doses.map(d => d.time).filter(Boolean);
    return times.length > 0 ? times : ['09:00'];
  }

  if (med.times && med.times.length > 0) {
    return med.times;
  }

  const timesPerDay = med.timesPerDay || 1;

  if (timesPerDay === 1) {
    return ['09:00'];
  } else if (timesPerDay === 2) {
    return ['09:00', '21:00'];
  } else if (timesPerDay === 3) {
    return ['09:00', '15:00', '21:00'];
  } else if (timesPerDay > 3) {
    return ['09:00', '15:00', '21:00'];
  }

  return ['09:00'];
}

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const LOW_STOCK_DOSE_THRESHOLD = 10;
const EXPIRING_SOON_DAYS = 30;
const MAX_SEND_LATENESS_MINUTES = 180;
const MAX_MISSED_LOOKBACK_MINUTES = 12 * 60;

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

function parseBottleRecord(bottleStr, zone = DEFAULT_TIME_ZONE) {
  if (!bottleStr || typeof bottleStr !== 'string') return null;

  const parts = bottleStr.split('/');
  if (parts.length < 3) return null;

  const expirationStr = `${parts[0]}/${parts[1]}/${parts[2]}`;

  const tz = zone || DEFAULT_TIME_ZONE;

  let expiration = DateTime.fromFormat(expirationStr, 'M/d/yyyy', { zone: tz });

  if (!expiration.isValid) {
    expiration = DateTime.fromFormat(expirationStr, 'MM/dd/yyyy', { zone: tz });
  }

  if (!expiration.isValid) {
    expiration = DateTime.fromISO(expirationStr, { zone: tz });
  }

  if (!expiration.isValid) return null;

  expiration = expiration.endOf('day');

  const quantityPart = parts[3];
  const quantity = quantityPart && quantityPart !== 'N/A' ? Number(quantityPart) : null;

  return { expiration, quantity };
}

function analyzeMedicationStock(med, nowDateTime) {
  const alerts = [];
  const medName = med.name || 'Medication';
  const dosage = Number(med.dosage) || 1;

  if (med.skipBottleTracking === true) {
    return alerts;
  }

  const bottles = Array.isArray(med.bottles)
    ? med.bottles.map(b => parseBottleRecord(b, nowDateTime && nowDateTime.zoneName)).filter(Boolean)
    : [];

  if (bottles.length === 0) {
    alerts.push({
      medName,
      type: 'out_of_stock',
      severity: 'critical',
      message: `${medName} has no bottles entered. Please order new ones and add them to the app.`
    });
    return alerts;
  }

  const sorted = [...bottles].sort((a, b) => a.expiration.toMillis() - b.expiration.toMillis());

  const activeBottle = sorted.find(b => b.expiration > nowDateTime && (b.quantity === null || b.quantity > 0))
    || sorted[0];

  const allExpired = sorted.every(b => b.expiration <= nowDateTime);
  const totalRemaining = sorted.reduce((sum, b) => {
    if (b.expiration <= nowDateTime) return sum;
    if (b.quantity === null) return sum + Infinity;
    return sum + b.quantity;
  }, 0);

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
  }

  if (totalRemaining === 0 && !allExpired) {
    alerts.push({
      medName,
      type: 'out_of_stock',
      severity: 'critical',
      message: `${medName} is out of stock. Order new ones.`
    });
    return alerts;
  }

  if (activeBottle.expiration <= nowDateTime) {
    return alerts;
  }

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

    if (med.deletedStatus === true) return;

    const medAlerts = analyzeMedicationStock(med, nowDateTime);
    alerts.push(...medAlerts);
  });

  alerts.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'critical' ? -1 : 1;
  });

  return alerts;
}

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

  if (nowDateTime < targetDateTime) {
    return false;
  }
  const diffMinutes = nowDateTime.diff(targetDateTime, 'minutes').minutes;
  if (diffMinutes > MAX_SEND_LATENESS_MINUTES) {
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

  return reminderDateTime.plus({ minutes: offsetMinutes });
}

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

  const missedYesterdayHtml = (Array.isArray(missedYesterday) && missedYesterday.length > 0)
    ? `
      <div style="margin-top:24px; padding:20px; background:#fef2f2; border:1px solid #ef4444; border-radius:16px;">
        <h3 style="margin:0 0 12px 0; color:#991b1b; font-size:18px;">⚠️ Yesterday's missed dose${missedYesterday.length > 1 ? 's' : ''}</h3>
        <div style="margin-bottom:10px; color:#7f1d1d; font-size:15px;">These doses were not marked taken yesterday and were auto-marked as missed. If you took any of them, you can correct the status in Everane.</div>
        ${missedYesterday.map(m => `
          <div style="margin-bottom:8px; padding:10px 14px; background:white; border-radius:10px; border:1px solid #fca5a5;">
            <span style="font-weight:700; color:#991b1b;">${escapeHtml(m.medName)}</span>
            <span style="color:#7f1d1d;"> &middot; dose #${m.doseNumber}${m.doseTime ? ' at ' + format12Hour(m.doseTime) : ''}</span>
          </div>
        `).join('')}
      </div>
    `
    : '';

  const scheduleItemsHtml = scheduleEntries.map((entry, index) => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    const doseLabel = entry.totalDoses > 1 ? `Dose ${entry.doseNumber}` : 'Scheduled dose';
    const dosageLabel = entry.dosage ? `<div class="agenda-entry-dose">${escapeHtml(entry.dosage)}</div>` : '';
    return `
      <div class="agenda-entry">
        <div class="agenda-entry-time">${timeLabel}</div>
        <div class="agenda-entry-body">
          <div class="agenda-entry-name">${doseLabel} · ${escapeHtml(entry.name)}</div>
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
                        <div style="font-weight:700; color:#991b1b; margin-bottom:4px;">${escapeHtml(alert.medName)}</div>
                        <div style="color:#991b1b; font-size:15px;">${escapeHtml(alert.message)}</div>
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
                        <div style="font-weight:600; color:#856404; margin-bottom:4px;">${escapeHtml(alert.medName)}</div>
                        <div style="color:#856404; font-size:15px;">${escapeHtml(alert.message)}</div>
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

async function sendMissedDoseEmail(userEmail, missedDoses) {
  if (missedDoses.length === 0) return;

  const nowDateTime = getNowInZone();
  const time12 = format12Hour(missedDoses[0].reminderTime);
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
        <p class="med-name">${escapeHtml(med.name)}</p>
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
      'Precedence': 'transactional'
    }
  };

  try {
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

async function checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, nowDateTime, db, userPhoneNumber = null, phoneVerified = false, pushSubscriptions = [], lastSentReminders = null) {
  const externalDedup = lastSentReminders && typeof lastSentReminders === 'object';
  const missedDedup = externalDedup ? lastSentReminders : {};

  const missedDoses = [];
  const updates = {};
  
  for (const medDoc of medicationsSnapshot.docs) {
    const rawData = medDoc.data();
    
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

    const channels = getMedChannels(med);
    if (med.deletedStatus || channels.size === 0) {
      continue;
    }
    
    const medSchedules = rawData.schedules || null;
    if (!medSchedules && (med.daysOfWeek.length > 0 || med.times.length > 0)) {
      const migrated = ScheduleUtils.migrateOldFormat(med);
      med.schedules = migrated.schedules;
    } else {
      med.schedules = medSchedules;
    }

    const dateContexts = [{ dt: nowDateTime, iso: nowDateTime.toISODate() }];
    if (nowDateTime.hour < 6) {
      const y = nowDateTime.minus({ days: 1 });
      dateContexts.unshift({ dt: y, iso: y.toISODate() });
    }

    for (const ctx of dateContexts) {
      if (!shouldSendReminderToday(med, ctx.dt)) continue;

      let allTodayDoses = [];
      if (med.schedules && med.schedules.length > 0) {
        allTodayDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, ctx.dt);
      } else if (med.times.length > 0) {
        allTodayDoses = med.times.filter(Boolean).sort().map((t, i) => ({ time: t, doseNumber: i + 1 }));
      }

      if (allTodayDoses.length === 0) continue;

    for (const dose of allTodayDoses) {
      const doseTime = dose.time;
      if (!doseTime) continue;

      const [doseHour, doseMinute] = doseTime.split(':').map(Number);
      if (Number.isNaN(doseHour) || Number.isNaN(doseMinute)) continue;

      const scheduledDateTime = ctx.dt.set({
        hour: doseHour,
        minute: doseMinute,
        second: 0,
        millisecond: 0
      });

      if (scheduledDateTime > nowDateTime) continue;

      const minutesPast = nowDateTime.diff(scheduledDateTime, 'minutes').minutes;
      if (minutesPast < 45) continue;
      if (minutesPast > MAX_MISSED_LOOKBACK_MINUTES) continue;

      const doseKey = `${ctx.iso}_${dose.doseNumber}`;
      const doseEntry = med.doses[doseKey];
      if (doseEntry && doseEntry.taken === true) continue;

      console.log(`[Missed Dose] ${med.name} dose #${dose.doseNumber} at ${doseTime} (${Math.floor(minutesPast)} min late)`);

      if (!doseEntry) {
        if (!updates[med.id]) {
          updates[med.id] = {
            medDocRef: db.collection('users').doc(userId).collection('medications').doc(med.id),
            doseUpdates: {}
          };
        }
        updates[med.id].doseUpdates[`doses.${doseKey}`] = {
          date: ctx.iso,
          doseNumber: dose.doseNumber,
          time: doseTime,
          taken: false,
          takenAt: null,
          autoMarked: true
        };
      }

      missedDoses.push({
        med,
        reminderTime: doseTime,
        doseNumber: dose.doseNumber,
        scheduledDateTime,
        dateIso: ctx.iso
      });
    }
    }
  }

  for (const [medId, update] of Object.entries(updates)) {
    try {
      await update.medDocRef.update(update.doseUpdates);
      console.log(`[Missed Dose] Updated ${update.medDocRef.id} with auto-marked doses`);
    } catch (error) {
      console.error(`[Missed Dose] Error updating ${medId}:`, error);
    }
  }
  
  const todayIso = nowDateTime.toISODate();
  const missedKey = (medId, doseNumber, channel, dateIso) =>
    `MISSED|${medId}|d${doseNumber}|${dateIso || todayIso}|${channel}`;

  const emailMissedDoses = missedDoses.filter(({ med, doseNumber, dateIso }) => {
    if (!getMedChannels(med).has('email')) return false;
    return !missedDedup[missedKey(med.id, doseNumber, 'email', dateIso)];
  });
  if (emailMissedDoses.length > 0 && userEmail) {
    for (const m of emailMissedDoses) {
      try {
        await sendMissedDoseEmail(userEmail, [m]);
        missedDedup[missedKey(m.med.id, m.doseNumber, 'email', m.dateIso)] = nowDateTime.toISO();
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
      }
    }
  }

  const smsMissedDoses = missedDoses.filter(({ med, doseNumber, dateIso }) => {
    if (!getMedChannels(med).has('sms')) return false;
    return !missedDedup[missedKey(med.id, doseNumber, 'sms', dateIso)];
  });
  if (smsMissedDoses.length > 0) {
    if (userPhoneNumber && phoneVerified) {
      try {
        await sendMissedDoseSMS(userPhoneNumber, smsMissedDoses, nowDateTime);
        for (const m of smsMissedDoses) {
          missedDedup[missedKey(m.med.id, m.doseNumber, 'sms', m.dateIso)] = nowDateTime.toISO();
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
          missedDedup[missedKey(m.med.id, m.doseNumber, 'sms', m.dateIso)] = nowDateTime.toISO();
        }
      }
    } else {
      for (const m of smsMissedDoses) {
        missedDedup[missedKey(m.med.id, m.doseNumber, 'sms', m.dateIso)] = nowDateTime.toISO();
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
  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const todayIndex = nowDateTime.weekday % 7;
  const weekdaysConst = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  const timezoneAbbr = nowDateTime.toFormat('ZZZZ');

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

  if (subjectPrefix) {
    subject = subjectPrefix + subject;
  }

  const headerTitle = isAtTime
    ? `Medication ${totalItems > 1 ? 'Reminders' : 'Reminder'}${alerts.length > 0 ? ' & Alerts' : ''}`
    : `Upcoming Medication Reminder${meds.length > 1 ? 's' : ''}`;
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
    
    const todayIso = nowDateTime.toISODate();
    const emailActionUrl = isAtTime && !isAlreadyTaken
      ? `${APP_BASE_URL}/email-action.html?medication=${encodeURIComponent(med.name)}&dose=${doseNumber}&time=${encodeURIComponent(scheduledTimeRaw || 'no-time')}&date=${todayIso}&medId=${med.id}`
      : null;
    
    console.log(`[Email Template] med: ${med.name}, offsetKey: ${offsetKey}, isAtTime: ${isAtTime}, isAlreadyTaken: ${isAlreadyTaken}, emailActionUrl exists: ${!!emailActionUrl}`);

    if (isAtTime) {
      const takenText = isAlreadyTaken ? ' (Already Taken)' : '';
      addTodaysText(`${doseLabel}: ${scheduledTime} – ${med.name}${takenText}`);
    }

    return `
      <div class="med-info" style="${isAlreadyTaken ? 'border-left-color: #10b981; background: #f0fdf4;' : ''}">
        <p class="med-name">${escapeHtml(med.name)}${isAlreadyTaken ? ' <span style="color: #10b981; font-size: 16px;">✓ Already Taken</span>' : ''}</p>
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
            <p class="alert-title">${alertIcon} ${alertTitle}: ${escapeHtml(med.name)}</p>
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
            <div style="font-weight:700; color:#991b1b; font-size:17px; margin-bottom:4px;">${escapeHtml(alert.medName)}</div>
            <div style="color:#991b1b; font-size:15px;">${escapeHtml(alert.message)}</div>
          </div>
        `).join('')}
      ` : ''}
      ${warningBottleAlerts.length > 0 ? `
        <h2 class="section-title" style="color:#856404; ${criticalBottleAlerts.length > 0 ? 'margin-top:20px;' : ''}">⚠️ Heads Up</h2>
        ${warningBottleAlerts.map(alert => `
          <div style="margin-bottom:12px; padding:16px; background:#fff8e1; border:1px solid #ffc107; border-left:5px solid #f59b45; border-radius:14px;">
            <div style="font-weight:700; color:#856404; font-size:17px; margin-bottom:4px;">${escapeHtml(alert.medName)}</div>
            <div style="color:#856404; font-size:15px;">${escapeHtml(alert.message)}</div>
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

  const reminderRef = `${nowDateTime.toFormat('yyyyLLdd-HHmm')}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubMailto = `mailto:${gmailEmail}?subject=${encodeURIComponent('Unsubscribe ' + (userEmail || ''))}`;
  const unsubLink = `${APP_BASE_URL}/profile.html`;

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
      'X-Entity-Ref-ID': reminderRef,
      'List-Unsubscribe': `<${unsubMailto}>, <${unsubLink}>`,
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


  const fullMessage = messageParts.join('\n');

  try {
    const result = await sendSMS(phoneNumber, fullMessage);
    console.log(`✅ Combined reminder SMS sent successfully to ${phoneNumber}`);
    console.log(`  Medications: ${meds.length}`);
    return result;
  } catch (error) {
    console.error('❌ Error sending combined SMS:', error);
    throw error;
  }
}

async function sendDailyAgendaSMS(phoneNumber, scheduleEntries, bottleAlerts = [], userTimezone = null) {
  if (!twilioClient || !twilioFromNumber) {
    throw new Error('Twilio not configured - cannot send SMS');
  }

  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const formattedDate = nowDateTime.toFormat('MMMM d, yyyy');

  let messageParts = [`Today's Medication Agenda - ${formattedDate}`, ''];

  scheduleEntries.forEach(entry => {
    const timeLabel = entry.time ? format12Hour(entry.time) : 'Any time';
    messageParts.push(`${timeLabel} - ${entry.name}${entry.dosage ? ` (${entry.dosage})` : ''}`);
  });


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

async function sendGroupOpenedEmail(userEmail, group, activeMembers, userTimezone = null) {
  const displayTimezone = userTimezone || DEFAULT_TIME_ZONE;
  const nowDateTime = getNowInZone(displayTimezone);
  const timezoneAbbr = nowDateTime.toFormat('ZZZZ');
  const groupName = group.name || 'your group';

  const styles = `
    body { margin:0; padding:0; background:#f4f7fb; font-family:"Segoe UI", Arial, sans-serif; color:#1f2933; }
    .wrapper { width:100%; padding:24px 0; }
    .container { width:90%; max-width:640px; margin:0 auto; background:white; border-radius:24px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12); }
    .header { background:linear-gradient(135deg,#22a06b,#15834f); padding:32px 28px; color:white; text-align:center; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.5px; }
    .header p { margin:12px 0 0; font-size:17px; font-weight:500; opacity:0.92; }
    .content { background:#f9f9f9; padding:32px 28px; line-height:1.7; font-size:18px; }
    .content-section { margin-bottom:24px; }
    .section-title { font-size:20px; font-weight:700; margin:0 0 14px; color:#15834f; letter-spacing:0.3px; }
    .med-item { display:flex; justify-content:space-between; align-items:center; background:white; padding:14px 18px; border-radius:14px; margin-bottom:10px; border-left:5px solid #22a06b; box-shadow:0 6px 18px rgba(34,160,107,0.12); }
    .med-name { font-weight:700; color:#1f3c2b; }
    .med-time { display:inline-flex; align-items:center; padding:6px 14px; border-radius:999px; background:#22a06b; color:white; font-weight:600; letter-spacing:0.3px; }
    .closing-note { margin:24px 0 0; font-size:17px; color:#1f2933; }
    .cta-wrap { text-align:center; margin-top:30px; }
    .cta { display:inline-block; padding:14px 32px; border-radius:14px; background:#22a06b; color:white; font-weight:700; letter-spacing:0.5px; text-decoration:none; box-shadow:0 12px 24px rgba(34,160,107,0.28); }
    .footer { text-align:center; font-size:15px; color:#61718f; padding:24px 28px 32px; background:#f8faff; line-height:1.6; }
  `;

  const memberRows = (activeMembers || []).map(m => `
    <div class="med-item">
      <span class="med-name">${escapeHtml(m.name)}</span>
      <span class="med-time">${m.time ? format12Hour(m.time) + ' ' + timezoneAbbr : 'Any time'}</span>
    </div>
  `).join('');

  const subject = sanitizeHeader(`Group "${groupName}" has opened up`);

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
            <h1>🔓 ${escapeHtml(groupName)} is open</h1>
            <p>Your medication group has opened up.</p>
          </div>
          <div class="content">
            <div class="content-section">
              <h2 class="section-title">Time to take these together</h2>
              ${memberRows || '<p>No medications listed.</p>'}
            </div>
            <p class="closing-note">✅ When you take them, make sure you tap <strong>Take All</strong> in Everane so we can keep your history up to date.</p>
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
  textLines.push(`Group "${groupName}" has opened up.`);
  textLines.push('');
  textLines.push('Take these together:');
  (activeMembers || []).forEach(m => {
    textLines.push(`- ${m.name}${m.time ? ` (${format12Hour(m.time)} ${timezoneAbbr})` : ''}`);
  });
  textLines.push('');
  textLines.push('When you take them, tap "Take All" in Everane.');
  textLines.push(`${APP_BASE_URL}/home.html`);
  const textBody = textLines.join('\n');

  const reminderRef = `${nowDateTime.toFormat('yyyyLLdd-HHmm')}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubMailto = `mailto:${gmailEmail}?subject=${encodeURIComponent('Unsubscribe ' + (userEmail || ''))}`;
  const unsubLink = `${APP_BASE_URL}/profile.html`;

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
      'X-Entity-Ref-ID': reminderRef,
      'List-Unsubscribe': `<${unsubMailto}>, <${unsubLink}>`,
      'Precedence': 'transactional'
    }
  };

  if (!gmailEmail || !gmailPassword) {
    throw new Error('Email configuration missing - cannot send group-opened email');
  }

  const result = await withRetry(
    `sendGroupOpenedEmail->${userEmail}`,
    () => transporter.sendMail(mailOptions),
    3,
    750
  );
  console.log(`✅ Group-opened email sent to ${userEmail} for group "${groupName}"`);
  return result;
}

exports.sendMedicationReminders = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB', maxInstances: 1 })
  .pubsub
  .schedule('every 1 minutes')
  .timeZone('UTC')
  .onRun(async (context) => {
    console.log('Starting medication reminder check...');
    console.log('Current UTC time:', new Date().toISOString());
    
    const db = admin.firestore();
    
    try {
      const usersSnapshot = await db.collection('users').get();
      console.log(`Found ${usersSnapshot.size} users`);
      
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const userData = userDoc.data();
        const userEmail = userData.email;


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

        try {
          const userTimezone = userData.timezone || DEFAULT_TIME_ZONE;
          const userNowDateTime = getNowInZone(userTimezone);
        
        const medicationsSnapshot = await db
          .collection('users')
          .doc(userId)
          .collection('medications')
          .get();
        
        
        if (medicationsSnapshot.size === 0) {
          continue;
        }
        
        const rawPreferences = Array.isArray(userData.notification_reminders) ? userData.notification_reminders : [];
        let reminderPreferences = Array.from(new Set(rawPreferences.filter(pref => REMINDER_OPTIONS[pref])));
        if (reminderPreferences.length === 0) {
          reminderPreferences = ['30_minutes_before', 'at_time'];
        }
        
        const lastSentReminders = userData.lastSentReminders || {};
        const todayIso = userNowDateTime.toISODate();

        const sendGroups = {};
        const alertMeds = [];
        
        const userPhoneNumber = userData.phone || null;
        const phoneVerified = userData.phoneVerified === true;
        const userPushSubscriptions = Array.isArray(userData.pushSubscriptions) ? userData.pushSubscriptions : [];
        const todaysSchedule = [];
        const scheduleKeys = new Set();
        const _diagMeds = [];

        for (const medDoc of medicationsSnapshot.docs) {
          const rawData = medDoc.data();
          
          const med = {
            id: medDoc.id,
            name: rawData.name || '',
            dosage: rawData.dosage || '',
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

          if (!med.schedules && (med.daysOfWeek.length > 0 || med.times.length > 0)) {
            const migrated = ScheduleUtils.migrateOldFormat(med);
            med.schedules = migrated.schedules;
          }

          if (med.deletedStatus === true) {
            _diagMeds.push(`${med.name}:DEL`);
            continue;
          }

          const channels = getMedChannels(med);
          const isEmailReminder = channels.has('email');
          const isSMSReminder = channels.has('sms');
          const isPushReminder = channels.has('push');

          if (!isEmailReminder && !isSMSReminder && !isPushReminder) {
            _diagMeds.push(`${med.name}:noChannels`);
            continue;
          }
          
          
          const shouldSendToday = shouldSendReminderToday(med, userNowDateTime);
          
          if (!shouldSendToday) {
            _diagMeds.push(`${med.name}:!today`);
            continue;
          }

          const todayIsoDate = userNowDateTime.toISODate();
          let allTodayDoses = [];

          if (med.schedules && med.schedules.length > 0) {
            allTodayDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, userNowDateTime);
          } else {
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

          for (const dose of allTodayDoses) {
            const doseTime = dose.time;
            const doseNumber = dose.doseNumber;
            const doseKey = `${todayIsoDate}_${doseNumber}`;
            const doseEntry = med.doses && med.doses[doseKey] ? med.doses[doseKey] : null;
            const isAlreadyTaken = doseEntry && doseEntry.taken === true;

            if (!doseTime) {
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

            const [doseHour, doseMinute] = doseTime.split(':').map(Number);
            if (Number.isNaN(doseHour) || Number.isNaN(doseMinute)) continue;

            for (const preference of reminderPreferences) {
              if (isAlreadyTaken && preference !== 'at_time') continue;

              const option = getReminderOption(preference);
              const targetDateTime = computeTargetDateTime(doseTime, option.minutes, userNowDateTime);
              if (!targetDateTime) continue;

              const shouldSend = shouldSendOffsetReminder(doseTime, option.minutes, userNowDateTime);

              if (shouldSend) {
                const isAtTimePref = preference === 'at_time';

                const baseKey = `${med.id}|${doseTime}|d${doseNumber}|${preference}|${todayIso}`;
                const emailKey = `${baseKey}|email`;
                const smsKey   = `${baseKey}|sms`;
                const pushKey  = `${baseKey}|push`;

                const needEmail = isEmailReminder && !lastSentReminders[emailKey];
                const needSMS   = isAtTimePref && isSMSReminder  && !lastSentReminders[smsKey];
                const needPush  = isAtTimePref && isPushReminder && !lastSentReminders[pushKey];

                if (!needEmail && !needSMS && !needPush) continue;

                const medWithStatus = { ...med, _isAlreadyTaken: isAlreadyTaken, _doseNumber: doseNumber, _doseTime: doseTime };
                const groupKey = `${preference}|${doseTime}`;
                if (!sendGroups[groupKey]) {
                  sendGroups[groupKey] = {
                    meds: [], emailMeds: [], smsMeds: [], pushMeds: [],
                    reminderTime: doseTime, offsetKey: preference,
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

          const largeAdvancePrefs = reminderPreferences.filter(p => {
            const opt = getReminderOption(p);
            return opt && opt.minutes < 0;
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
                const targetDateTime = computeTargetDateTimeTomorrow(dose.time, option.minutes, userNowDateTime);
                if (!targetDateTime) continue;
                const diffMinutes = userNowDateTime.diff(targetDateTime, 'minutes').minutes;
                const shouldSend = diffMinutes >= 0 && diffMinutes <= MAX_SEND_LATENESS_MINUTES;
                if (shouldSend) {
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
                  sendGroups[groupKey].channelKeysByMed[med.id] = { email: emailKey, sms: null, push: null };
                  sendGroups[groupKey].emailMeds.push(medWithStatus);
                }
              }
            }
          }

          _diagMeds.push(`${med.name}:[${doseDiagParts.join(',')}](${Array.from(channels).sort().join('+') || 'none'})`);
        }
        
        console.log(`[DIAG] ${userEmail} now=${userNowDateTime.toFormat('HH:mm')} prefs=${JSON.stringify(reminderPreferences)} pushDevices=${userPushSubscriptions.length} groups=${Object.keys(sendGroups).length} | ${_diagMeds.join(', ')}`);

        let sentAtTimeNineAM = false;

        const bottleAlerts = await getBottleAlertsForUser(userId, userNowDateTime);

        for (const [groupKey, group] of Object.entries(sendGroups)) {
          if (!group || group.meds.length === 0) {
            continue;
          }

          if (group.offsetKey === 'at_time' && group.reminderTime === '09:00') {
            sentAtTimeNineAM = true;
          }
          const includeAlerts = [];

          const emailDelivered = {};
          const smsDelivered = {};
          const pushDelivered = {};

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
            }
          }

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
                for (const m of group.smsMeds) {
                  await recordSendAttempt(db, userId, {
                    channel: 'sms', medId: m.id, medName: m.name,
                    doseNumber: m._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: 'failed', error: smsThrew && smsThrew.message || String(smsThrew)
                  });
                }
              } else {
                const sid = smsResult && (smsResult.sid || smsResult.id);
                let carrierFailed = false;
                let dlrInfo = null;
                if (sid) {
                  for (const waitMs of [2500]) {
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
            const orphaned = group.pushMeds.filter(m => {
              const ch = getMedChannels(m);
              return !ch.has('email') && !ch.has('sms');
            });

            if (orphaned.length > 0 && userEmail) {
              try {
                await sendCombinedReminderEmail(
                  userEmail, orphaned, group.reminderTime, group.offsetKey,
                  [], todaysSchedule, bottleAlerts, userTimezone
                );
                for (const m of orphaned) {
                  await recordSendAttempt(db, userId, {
                    channel: 'email', medId: m.id, medName: m.name,
                    doseNumber: m._doseNumber, doseTime: group.reminderTime,
                    offsetKey: group.offsetKey, date: todayIso,
                    status: 'sent', reason: 'fallback: push selected but no subscribed device'
                  });
                }
                console.warn(`No push device for ${userEmail}; sent email fallback for ${orphaned.length} push-only med(s)`);
              } catch (fbErr) {
                console.error('Push-fallback email failed:', fbErr.message);
              }
            }

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
            const cgKey = `CGFWD|${group.offsetKey}|${group.reminderTime}|${todayIso}|email`;
            if (!lastSentReminders[cgKey]) {
              try {
                const patientName = userData.name || userEmail;
                await forwardRemindersToCaregiver(db, userId, patientName, group.meds, group.reminderTime, group.offsetKey, userTimezone);
                lastSentReminders[cgKey] = userNowDateTime.toISO();
              } catch (cgErr) {
                console.warn(`[CaregiverReminders] Error forwarding for ${userId}:`, cgErr.message);
              }
            }
          } else {
            console.log(`  ⚠️ No channels succeeded for group ${groupKey} — will retry next run`);
          }
        }
        
        if (Object.keys(sendGroups).length === 0) {
        }
        
        if (Object.keys(lastSentReminders).length > 0) {
          try {
            const twoDaysAgo = userNowDateTime.minus({ days: 2 }).toISODate();
            const isoDate = /^\d{4}-\d{2}-\d{2}$/;
            Object.keys(lastSentReminders).forEach(key => {
              const parts = key.split('|');
              const last = parts[parts.length - 1];
              const isChannelKey = last === 'email' || last === 'sms' || last === 'push';
              let keyDate = null;
              if (isChannelKey) {
                if (parts.length >= 2 && isoDate.test(parts[parts.length - 2])) {
                  keyDate = parts[parts.length - 2];
                }
              } else if (isoDate.test(last)) {
                keyDate = last;
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
        
        try {
          const groupsSnapshot = await db
            .collection('users')
            .doc(userId)
            .collection('groups')
            .get();

          if (!groupsSnapshot.empty) {
            const medsById = {};
            for (const medDoc of medicationsSnapshot.docs) {
              const raw = medDoc.data();
              if (raw.deletedStatus === true) continue;
              let schedules = raw.schedules || null;
              if (!schedules && ((raw.daysOfWeek || raw.days || []).length > 0 || (raw.times || []).length > 0)) {
                schedules = ScheduleUtils.migrateOldFormat({
                  daysOfWeek: raw.daysOfWeek || raw.days || [],
                  times: Array.isArray(raw.times) ? raw.times.filter(Boolean) : [],
                  timesPerDay: raw.timesPerDay || 0,
                  startDate: raw.startDate || null,
                  endDate: raw.endDate || null
                }).schedules;
              }
              medsById[medDoc.id] = { id: medDoc.id, name: raw.name || 'Medication', schedules: schedules || [] };
            }

            const nowMinutes = userNowDateTime.hour * 60 + userNowDateTime.minute;
            let groupEmailSent = false;

            for (const groupDoc of groupsSnapshot.docs) {
              const group = { id: groupDoc.id, ...groupDoc.data() };
              const members = Array.isArray(group.members) ? group.members : [];
              if (members.length === 0) continue;

              const activeMembers = [];
              for (const member of members) {
                const med = medsById[member.medId];
                if (!med || !Array.isArray(med.schedules) || med.schedules.length === 0) continue;
                const todayDoses = ScheduleUtils.getScheduledDosesForDate(med.schedules, userNowDateTime);
                const matchingDose = todayDoses.find(d => d.time === member.time);
                if (matchingDose) {
                  activeMembers.push({ name: med.name, time: member.time });
                }
              }

              if (activeMembers.length === 0) continue;

              const memberMinutes = activeMembers
                .map(m => {
                  const [hh, mm] = String(m.time).split(':').map(Number);
                  return (Number.isNaN(hh) ? null : hh * 60 + (mm || 0));
                })
                .filter(v => v !== null);
              if (memberMinutes.length === 0) continue;

              const earliestMin = Math.min(...memberMinutes);
              const unlockAt = earliestMin - 60;
              const latestMin = Math.max(...memberMinutes);
              const lockAt = latestMin + 60;

              if (nowMinutes < unlockAt || nowMinutes > lockAt) continue;

              const dedupKey = `GROUP_OPENED|${group.id}|${todayIso}|email`;
              if (lastSentReminders[dedupKey]) continue;

              try {
                await sendGroupOpenedEmail(userEmail, group, activeMembers, userTimezone);
                lastSentReminders[dedupKey] = userNowDateTime.toISO();
                groupEmailSent = true;
                console.log(`  Marked sent: ${dedupKey}`);
              } catch (gErr) {
                console.warn(`[GroupOpened] Failed for group ${group.id} (${userId}):`, gErr.message);
              }
            }

            if (groupEmailSent) {
              await db.collection('users').doc(userId).set({
                lastSentReminders: lastSentReminders
              }, { merge: true });
            }
          }
        } catch (groupErr) {
          console.error(`Failed to process group-opened reminders for ${userId}:`, groupErr.message);
        }


        try {
          await checkAndMarkMissedDoses(userId, userEmail, medicationsSnapshot, userNowDateTime, db, userPhoneNumber, phoneVerified, userPushSubscriptions, lastSentReminders);

          await db.collection('users').doc(userId).set({
            lastSentReminders: lastSentReminders
          }, { merge: true });
        } catch (error) {
          console.error(`Failed to check missed doses for ${userId}:`, error);
        }
        
        // Only print the per-user summary when this cycle actually did
        // something. At one run per minute the idle version buried real
        // events under ~150 lines/minute, making a whole day unreadable.
        if (Object.keys(sendGroups).length > 0) {
          console.log(`\n=== SUMMARY FOR USER ${userId} ===`);
          console.log(`  Email: ${userEmail}`);
          console.log(`  Timezone: ${userTimezone}`);
          console.log(`  Current time: ${userNowDateTime.toFormat('yyyy-MM-dd HH:mm:ss')}`);
          console.log(`  Medications checked: ${medicationsSnapshot.size}`);
          console.log(`  Send groups created: ${Object.keys(sendGroups).length}`);
          console.log(`  Bottle alerts found: ${bottleAlerts.length} (${bottleAlerts.filter(a => a.severity === 'critical').length} critical)`);
          console.log(`  Emails queued: ${Object.values(sendGroups).reduce((sum, g) => sum + (g.meds ? g.meds.length : 0), 0)}`);
          console.log(`===================================\n`);
        }

        try {
          const groupCount = Object.keys(sendGroups).length;
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
        try {
          await db.collection('users').doc(userId).collection('sendAuditLog').doc(`err_${Date.now()}_${Math.random().toString(36).slice(2,6)}`).set({
            ts: new Date().toISOString(),
            channel: 'cycle',
            status: 'failed',
            error: (error && error.message) || String(error),
            reason: 'user-loop-uncaught'
          });
        } catch (_) {}
      }
    }
      
      console.log('Medication reminder check completed');
      return null;
    } catch (error) {
      console.error('Error in medication reminder function:', error);
      throw error;
    }
  });

exports.sendDailyAgenda = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB', maxInstances: 1 })
  .pubsub
  .schedule('every 1 minutes')
  .timeZone('UTC')
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

      const userTimezone = userData.timezone || DEFAULT_TIME_ZONE;
      const userNow = getNowInZone(userTimezone);
      const todayIso = userNow.toISODate();
      
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
          await userDoc.ref.set({ lastAgendaSentDate: todayIso }, { merge: true });
          continue;
        }

        const bottleAlerts = await getBottleAlertsForUser(userDoc.id, userNow);
        const userPhoneNumber = userData.phone || null;
        const phoneVerified = userData.phoneVerified === true;

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

        const yesterdayIso = userNow.minus({ days: 1 }).toISODate();
        const missedYesterday = [];
        medsSnap.forEach(d => {
          const data = d.data() || {};
          if (data.deletedStatus === true) return;
          const doses = data.doses || {};
          Object.keys(doses).forEach(key => {
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
        missedYesterday.sort((a, b) => String(a.doseTime).localeCompare(String(b.doseTime)));

        let sentAny = false;
        let attemptedAny = false;
        if (hasEmailMed) {
          attemptedAny = true;
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
          attemptedAny = true;
          try {
            await sendDailyAgendaSMS(userPhoneNumber, scheduleEntries, bottleAlerts, userTimezone);
            sentAny = true;
            console.log(`Daily agenda SMS sent to ${userPhoneNumber}`);
          } catch (e) {
            console.error(`Failed to send daily agenda SMS for ${userPhoneNumber}`, e.message);
          }
        }

        if (sentAny || !attemptedAny) {
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

  const safeCaregiverName = escapeHtml(caregiverName);
  const safePatientFirstName = escapeHtml(patientFirstName);
  const messageBoxHtml = customMessage
    ? `<div class="message-box"><strong>Message from ${safeCaregiverName}:</strong><br><br>"${escapeHtml(customMessage)}"</div>`
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
            <p>Hello ${safePatientFirstName},</p>
            <p>${safeCaregiverName} has invited you to share medication updates through Everane.</p>
            <p>If you accept, ${safeCaregiverName} will be able to receive medication-related updates (such as adherence summaries or expiration alerts) based on the preferences you choose. Your medications cannot be changed by anyone else.</p>
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

exports.sendCaregiverInvitation = functions.https.onRequest(async (req, res) => {
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
    const authHeader = req.headers.authorization || '';
    const idToken =
      (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '') ||
      (typeof req.body?.idToken === 'string' ? req.body.idToken : '');
    if (!idToken) {
      res.status(401).json({ error: 'Missing auth token' });
      return;
    }
    let decodedCaller;
    try {
      decodedCaller = await admin.auth().verifyIdToken(idToken);
    } catch (_) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }
    if (!decodedCaller?.uid) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }

    const { patientEmail, caregiverId, customMessage } = req.body;

    if (!patientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      res.status(400).json({ error: 'Valid patient email address is required' });
      return;
    }

    if (caregiverId && caregiverId !== decodedCaller.uid) {
      res.status(403).json({ error: 'You can only send invitations as yourself' });
      return;
    }

    const callerSnap = await admin.firestore().collection('users').doc(decodedCaller.uid).get();
    if (!callerSnap.exists) {
      res.status(403).json({ error: 'Caregiver profile not found' });
      return;
    }
    const callerData = callerSnap.data() || {};
    const caregiverName = callerData.name || 'A caregiver';

    if (typeof customMessage === 'string' && customMessage.length > 1000) {
      res.status(400).json({ error: 'Message is too long' });
      return;
    }

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
    const patientFirstName = patientName.split(' ')[0];

    const invitationId = db.collection('invitations').doc().id;

    await db.collection('invitations').doc(invitationId).set({
      caregiverId: decodedCaller.uid,
      caregiverName: caregiverName,
      patientEmail: patientEmail.toLowerCase(),
      patientName: patientName,
      customMessage: customMessage || null,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

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

exports.acceptCaregiverInvitation = functions.https.onRequest(async (req, res) => {
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

    const authHeader = req.headers.authorization || '';
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

    const caregiverDocRef = db.collection('users').doc(caregiverId);
    await caregiverDocRef.set({
      patients: admin.firestore.FieldValue.arrayUnion(patientEmailLower),
      patientIds: admin.firestore.FieldValue.arrayUnion(patientId)
    }, { merge: true });

    const patientDocRef = db.collection('users').doc(patientId);
    await patientDocRef.set({
      caregivers: admin.firestore.FieldValue.arrayUnion(caregiverId)
    }, { merge: true });

    await invitationRef.set({
      status: 'accepted',
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      patientId: patientId
    }, { merge: true });

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

      await db.collection('users').doc(patientId).set({
        caregivers: admin.firestore.FieldValue.arrayUnion(caregiverId)
      }, { merge: true });

      linked += 1;
    }

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
  for (const email of emails) {
    const qs = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!qs.empty) ids.push(qs.docs[0].id);
  }
  return ids;
}

async function findCaregiverReminderRecipients(db, patientId) {
  const recipients = [];
  try {
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

async function forwardRemindersToCaregiver(db, patientId, patientName, meds, reminderTime, offsetKey, userTimezone) {
  try {
    const recipients = await findCaregiverReminderRecipients(db, patientId);
    if (recipients.length === 0) return;

    for (const r of recipients) {
      if (r.prefs && r.prefs.email && r.email) {
        try {
          const medsCopy = meds.map(m => ({ ...m }));
          await sendCombinedReminderEmail(
            r.email, medsCopy, reminderTime, offsetKey,
            [], [], [], userTimezone,
            `[${patientName}] `
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

      const times = getReminderTimes(med, day);
      const dayTimes = Array.isArray(times) && times.length > 0 ? times : [null];

      for (let idx = 0; idx < dayTimes.length; idx += 1) {
        const doseNumber = idx + 1;
        const doseTime = dayTimes[idx];

        if (doseTime) {
          const [hh, mm] = String(doseTime).split(':').map(Number);
          if (!Number.isNaN(hh)) {
            const due = day.set({ hour: hh, minute: mm || 0, second: 0, millisecond: 0 });
            if (due > nowDateTime) continue;
          }
        } else if (day.hasSame(nowDateTime, 'day')) {
          continue;
        }

        total += 1;
        const key = `${dayIso}_${doseNumber}`;
        const entry = med.doses ? med.doses[key] : null;

        if (entry && entry.taken === true) {
          taken += 1;
        } else {
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

async function sendCaregiverNotification(caregiverData, subject, htmlBody, textBody) {
  const caregiverEmail = caregiverData.email;
  if (caregiverEmail) {
    await sendCaregiverEmail(caregiverEmail, subject, htmlBody, textBody);
  }
}

async function markCaregiverEmailSent(db, caregiverId, key) {
  const ref = db.collection('users').doc(caregiverId);
  const updateObj = { [`caregiverEmailState.${key}`]: admin.firestore.FieldValue.serverTimestamp() };
  try {
    await ref.update(updateObj);
  } catch (e) {
    await ref.set(updateObj, { merge: true });
  }
}

function caregiverAlreadySent(caregiverData, key) {
  return Boolean(caregiverData?.caregiverEmailState && caregiverData.caregiverEmailState[key]);
}

exports.sendCaregiverExpirationDatesEmails = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('0 9 * * *')
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

        const alertsHtml = bottleAlerts.map(a => `<li style="margin:6px 0;">${escapeHtml(a.message)}</li>`).join('');
        sectionsHtml.push(`
          <div style="padding:16px 16px; border:1px solid #d7e3ff; border-radius:16px; background:#ffffff; margin:14px 0;">
            <div style="font-size:18px; font-weight:800; color:#1f3c88;">${escapeHtml(patient.name)}</div>
            <div style="color:#64748b; margin-top:4px; font-size:14px;">${escapeHtml(patient.email || '')}</div>
            <ul style="margin:12px 0 0; padding-left:18px; color:#0f172a; font-size:15px; line-height:1.5;">
              ${alertsHtml}
            </ul>
          </div>
        `);
      }

      if (sectionsHtml.length === 0) {
        continue;
      }

      const subject = 'Everane: Patient expiration alerts';
      const htmlBody = `
        <div style="background:#f4f7fb; padding:24px 0; font-family:Segoe UI, Arial, sans-serif; color:#0f172a;">
          <div style="width:92%; max-width:680px; margin:0 auto; background:#ffffff; border-radius:22px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.12);">
            <div style="background:linear-gradient(135deg,#3f6ff5,#2850c6); padding:26px 22px; color:#fff; text-align:center;">
              <div style="font-size:22px; font-weight:900;">Patient expiration alerts</div>
              <div style="margin-top:8px; opacity:.92; font-weight:600;">Stock, refill and expiration alerts across your patients</div>
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
        'Stock, refill and expiration alerts across your patients',
        '',
        ...linesText
      ].join('\n');

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        await markCaregiverEmailSent(db, caregiverId, todayKey);
      } catch (cgErr) {
        console.error(`[Caregiver] expiration digest failed for ${caregiverEmail} (${caregiverId}):`, cgErr.message);
        continue;
      }
      console.log(`[Caregiver] Sent expiration digest to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverAdherenceBelow80Alerts = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('30 9 * * *')
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
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${escapeHtml(patient.name)}</td>
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

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        await markCaregiverEmailSent(db, caregiverId, todayKey);
      } catch (cgErr) {
        console.error(`[Caregiver] adherence<80 alert failed for ${caregiverEmail} (${caregiverId}):`, cgErr.message);
        continue;
      }
      console.log(`[Caregiver] Sent adherence<80 alert to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverWeeklyReports = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('0 9 * * 1')
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
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${escapeHtml(patient.name)}</td>
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

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        await markCaregiverEmailSent(db, caregiverId, weekKey);
      } catch (cgErr) {
        console.error(`[Caregiver] weekly report failed for ${caregiverEmail} (${caregiverId}):`, cgErr.message);
        continue;
      }
      console.log(`[Caregiver] Sent weekly report to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendCaregiverMonthlyReports = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('0 9 1 * *')
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
            <td style="padding:10px 12px; border-bottom:1px solid #e5ecff; font-weight:800; color:#1f3c88;">${escapeHtml(patient.name)}</td>
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

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        await markCaregiverEmailSent(db, caregiverId, monthKey);
      } catch (cgErr) {
        console.error(`[Caregiver] monthly report failed for ${caregiverEmail} (${caregiverId}):`, cgErr.message);
        continue;
      }
      console.log(`[Caregiver] Sent monthly report to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.onPatientMedicationCreated = functions.firestore
  .document('users/{userId}/medications/{medId}')
  .onCreate(async (snap, context) => {
    const db = admin.firestore();
    const patientId = context.params.userId;
    const medData = snap.data() || {};
    const medName = medData.name || 'a medication';

    if (medData.deletedStatus === true) return null;

    const patient = await loadPatientProfile(db, patientId);
    if (!patient) return null;

    const allCaregivers = await db.collection('users').where('type', '==', 'C').get();

    for (const caregiverDoc of allCaregivers.docs) {
      const caregiverData = caregiverDoc.data() || {};
      const reminders = Array.isArray(caregiverData.email_reminders) ? caregiverData.email_reminders : [];
      if (!reminders.includes(CAREGIVER_EMAIL_KEYS.NEW_MEDICATION_ADDED)) continue;

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
                <div style="font-size:18px; font-weight:800; color:#1f3c88;">${escapeHtml(patient.name)}</div>
                <div style="color:#64748b; margin-top:4px; font-size:14px;">${escapeHtml(patient.email || '')}</div>
                <div style="margin-top:12px; font-size:16px; color:#0f172a;">
                  Added: <strong>${escapeHtml(medName)}</strong>${medData.dosage ? ` (${escapeHtml(medData.dosage)})` : ''}
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

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        console.log(`[Caregiver] Sent new-med alert to ${caregiverEmail} for patient ${patientId}`);
      } catch (err) {
        console.error(`[Caregiver] Failed new-med alert to ${caregiverEmail}:`, err.message);
      }
    }

    return null;
  });

exports.sendCaregiverNothingRecordedAlerts = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('0 21 * * *')
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

        let anyRecorded = false;
        for (const med of activeMeds) {
          if (!shouldSendReminderToday(med, patientNow)) continue;
          const doses = med.doses || {};
          for (const key of Object.keys(doses)) {
            if (!key.startsWith(todayIso + '_')) continue;
            const entry = doses[key];
            if (entry && entry.taken === true) {
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
              <div style="font-size:18px; font-weight:800; color:#dc2626;">${escapeHtml(patient.name)}</div>
              <div style="color:#64748b; margin-top:4px; font-size:14px;">${escapeHtml(patient.email || '')}</div>
              <div style="margin-top:8px; font-size:15px; color:#0f172a;">No doses recorded today.</div>
            </div>
          `);
        }
      }

      if (sectionsHtml.length === 0) continue;

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

      try {
        await sendCaregiverNotification(caregiverData, subject, htmlBody, textBody);
        await markCaregiverEmailSent(db, caregiverId, todayKey);
      } catch (cgErr) {
        console.error(`[Caregiver] nothing-recorded alert failed for ${caregiverEmail} (${caregiverId}):`, cgErr.message);
        continue;
      }
      console.log(`[Caregiver] Sent nothing-recorded alert to ${caregiverEmail} (${caregiverId})`);
    }

    return null;
  });

exports.sendPhoneVerificationCode = functions.https.onRequest((req, res) => {
  console.log('🚀 FUNCTION CALLED - sendPhoneVerificationCode');
  console.log('  Method:', req.method);

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

      const authHeader = req.headers.authorization || '';
      const idToken =
        (authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '') ||
        (typeof req.body?.idToken === 'string' ? req.body.idToken : '');
      if (!idToken) {
        res.status(401).json({ error: 'Missing auth token' });
        return;
      }
      try {
        const decodedCaller = await admin.auth().verifyIdToken(idToken);
        if (!decodedCaller?.uid) throw new Error('no uid');
      } catch (_) {
        res.status(401).json({ error: 'Invalid auth token' });
        return;
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const db = admin.firestore();
      await db.collection('phoneVerifications').doc(phoneNumber).set({
        code: code,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

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

exports.verifyPhoneCode = functions.https.onRequest((req, res) => {
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

      if (new Date() > expiresAt) {
        await db.collection('phoneVerifications').doc(phoneNumber).delete();
        res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
        return;
      }

      if (verification.code !== code) {
        res.status(400).json({ error: 'Invalid verification code' });
        return;
      }

      await db.collection('phoneVerifications').doc(phoneNumber).delete();
      console.log('✅ Phone verification code approved!');

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

exports.sendContactForm = functions.https.onRequest((req, res) => {
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

      if (!name || !email || !message) {
        res.status(400).json({ error: 'Name, email, and message are all required' });
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'A valid email address is required' });
        return;
      }

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
                <td style="padding: 10px 12px; color: #333333; border-bottom: 1px solid #eeeeee;">${escapeHtml(name)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 12px; font-weight: bold; color: #555555; border-bottom: 1px solid #eeeeee;">Email</td>
                <td style="padding: 10px 12px; color: #333333; border-bottom: 1px solid #eeeeee;"><a href="mailto:${encodeURIComponent(email)}" style="color: #4A90D9;">${escapeHtml(email)}</a></td>
              </tr>
            </table>
            <div style="margin-top: 20px;">
              <h3 style="color: #555555; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Message</h3>
              <div style="background-color: #f9f9f9; border-left: 4px solid #4A90D9; padding: 16px; border-radius: 4px; color: #333333; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(message)}</div>
            </div>
            <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;" />
            <p style="color: #999999; font-size: 12px; text-align: center; margin-bottom: 0;">This email was sent from the Everane contact form. Reply directly to respond to the sender.</p>
          </div>
        </div>
      `;

      const mailOptions = {
        from: gmailEmail,
        replyTo: email,
        to: 'rishikeshalladi@gmail.com',
        subject: sanitizeHeader(`[Everane Contact] Message from ${name}`),
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


const AI_DAILY_LIMITS = {
  realtime: 40,
  imageExtract: 60,
  medLookup: 300
};

async function callerLocalDate(uid) {
  let zone = DEFAULT_TIME_ZONE;
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    const tz = snap.exists && (snap.data() || {}).timezone;
    if (tz && DateTime.now().setZone(tz).isValid) zone = tz;
  } catch (e) {
    console.warn(`[AI] timezone lookup failed for ${uid}, using ${DEFAULT_TIME_ZONE}:`, e.message);
  }
  return DateTime.now().setZone(zone).toISODate();
}

async function requireVerifiedCaller(req) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.idToken || '');
  if (!idToken) return { ok: false, status: 401, error: 'Missing auth token' };

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (_) {
    return { ok: false, status: 401, error: 'Invalid auth token' };
  }
  if (!decoded || !decoded.uid) return { ok: false, status: 401, error: 'Invalid auth token' };

  if (decoded.email_verified !== true) {
    try {
      const rec = await admin.auth().getUser(decoded.uid);
      if (!rec.emailVerified) {
        return { ok: false, status: 403, error: 'Please verify your email address first.' };
      }
    } catch (_) {
      return { ok: false, status: 403, error: 'Please verify your email address first.' };
    }
  }

  return { ok: true, uid: decoded.uid, email: decoded.email || null };
}

async function consumeAiQuota(uid, kind, limit) {
  try {
    const dayKey = DateTime.utc().toISODate();
    const ref = admin.firestore()
      .collection('users').doc(uid)
      .collection('aiUsage').doc(`${kind}_${dayKey}`);

    const snap = await ref.get();
    const used = snap.exists ? Number(snap.data().count || 0) : 0;
    if (used >= limit) {
      console.warn(`[AI quota] ${uid} hit ${kind} limit (${used}/${limit})`);
      return { allowed: false, used, limit };
    }
    await ref.set({
      count: admin.firestore.FieldValue.increment(1),
      kind,
      day: dayKey,
      lastAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { allowed: true, used: used + 1, limit };
  } catch (e) {
    console.warn(`[AI quota] bookkeeping failed for ${uid}/${kind} — allowing through:`, e.message);
    return { allowed: true, used: 0, limit, degraded: true };
  }
}

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
      const caller = await requireVerifiedCaller(req);
      if (!caller.ok) {
        res.status(caller.status).json({ error: caller.error });
        return;
      }

      const quota = await consumeAiQuota(caller.uid, 'realtime', AI_DAILY_LIMITS.realtime);
      if (!quota.allowed) {
        res.status(429).json({ error: 'Daily voice-session limit reached. Please try again tomorrow.' });
        return;
      }

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) {
        res.status(500).json({ error: 'OpenAI API key not configured' });
        return;
      }

      const realtimeToday = await callerLocalDate(caller.uid);

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
            instructions: 'You are a medication data collector for Everane. You collect 6 fields one at a time through conversation.\n\nCRITICAL RULE: Each response must contain ONLY ONE short question or acknowledgment. Never ask multiple questions. Never give medical facts, advice, drug information, or commentary. Never mention side effects or drug interactions.\n\nThe 6 fields to collect in order:\n- name: medication name\n- dosage: e.g. "2 pills", "1 tablet", "500 mg". Accept the first answer. Never ask follow-ups about strength or milligrams.\n- schedule: days and times. If they say morning/evening, ask for exact time. Ask if they want to add another schedule.\n- startDate: convert to YYYY-MM-DD. Today is ' + realtimeToday + '. Resolve relative dates such as "today", "tomorrow" or "next Monday" against that date, and if the user gives no year use the year of that date.\n- endDate: YYYY-MM-DD or null if ongoing\n- reminderChannels: How the user wants to be reminded. Ask exactly: "How would you like to be reminded? You can pick email, text message, push notifications, or any combination — or say none." Accept MULTIPLE channels in a single answer (e.g. "email and text"). Valid values are any subset of ["email","sms","push"]. Map "text", "text message", or "texts" to "sms". An empty array means no reminders. If the user picks sms, do not ask for their phone number — they enter it in their profile.\n\nStart by asking for the medication name. After the user answers each question, acknowledge briefly and ask the next one. After collecting all 6, say "All set!" and call submit_medication_draft immediately. Do not recap or summarize.\n\nIf the user asks a follow-up question, asks you to repeat something, or asks for clarification, answer it briefly and then continue collecting the next field.\n\nCRITICAL — ANTI-ASSUMPTION RULES (MUST FOLLOW):\n1. NEVER move to the next question until the user has given a clear, audible verbal answer to the current question.\n2. If you hear silence, background noise, or anything unclear, say "Sorry, I didn\'t catch that. Could you repeat your answer?" Do NOT treat silence as an answer.\n3. NEVER guess, assume, or fill in ANY field on your own. Every single field value must come directly from the user\'s spoken words.\n4. If the user\'s response is ambiguous or partial, ask a clarifying follow-up before moving on.\n5. Do NOT skip ahead. Do NOT bundle questions. Ask exactly one question, then STOP and WAIT.\n6. If you are unsure whether the user answered, ask again. It is always better to re-ask than to assume.\n7. NEVER auto-advance to the next field based on context clues, previous answers, or common defaults.',
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
            max_output_tokens: 500,
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
      const clientSecret = sessionData.value
        || sessionData.client_secret?.value
        || sessionData.client_secret;

      if (!clientSecret) {
        console.error('❌ Could not extract client_secret from response:', JSON.stringify(sessionData).slice(0, 500));
        res.status(500).json({ error: 'Could not extract client_secret from OpenAI response' });
        return;
      }

      console.log(`✅ Created Realtime client secret for session ${sessionData.session?.id || 'unknown'} (uid=${caller.uid}, ${quota.used}/${quota.limit} today)`);

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

const MED_IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MED_IMAGE_HOST_ALLOWLIST = new Set([
  'nih.gov', 'nlm.nih.gov', 'dailymed.nlm.nih.gov', 'medlineplus.gov', 'fda.gov', 'cdc.gov',
  'walgreens.com', 'cvs.com', 'riteaid.com', 'walmart.com', 'target.com', 'costco.com',
  'samsclub.com', 'kroger.com', 'amazon.com', 'ssl-images-amazon.com', 'media-amazon.com',
  'sainsburys.co.uk', 'boots.com', 'chemistwarehouse.com.au', 'shopkodiak.com',
  'healthwarehouse.com', 'pillpack.com', 'costcobusinessdelivery.com',
  'drugs.com', 'goodrx.com', 'rxlist.com', 'webmd.com', 'healthline.com', 'medicines.org.uk',
  'empr.com', 'pdr.net', 'druginfo.nlm.nih.gov', 'epocrates.com', 'medscape.com',
  'mckesson.com', 'cardinalhealth.com', 'amerisourcebergen.com', 'teva.com', 'pfizer.com',
  'novartis.com', 'lilly.com', 'sandoz.com', 'viatris.com', 'sunpharma.com',
  'henryschein.com', 'medline.com', 'macgill.com', 'bettymills.com',
  'mountainside-medical.com', 'empowerpharmacy.com', 'mms.mckesson.com',
  'mediusa.com', 'moorebrand.com', 'discountmedicalsupplies.com', 'vitalitymedical.com',
  'praxisdental.com', 'dentalhealthproducts.com', 'schein.com',
  'plushcare.com', 'lemonaidhealth.com', 'ro.co', 'hims.com', 'capsule.com',
  'medpagetoday.net', 'singlecare.com', 'optum.com', 'expressscripts.com',
  'shopify.com', 'shopifycdn.com', 'squarespace-cdn.com', 'bigcommerce.com',
  'wikimedia.org', 'wikipedia.org',
]);

const MED_IMAGE_CACHE_VERSION = 'v4-fda-grounded-summary';

async function fetchFdaLabel(term) {
  const q = String(term || '').trim();
  if (q.length < 2) return null;

  const url = 'https://api.fda.gov/drug/label.json?search=' +
    encodeURIComponent(`openfda.generic_name:"${q}"`) + '&limit=10';

  let data;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return null;
    data = await resp.json();
  } catch (e) {
    console.warn('[FDA] label fetch failed:', e.message);
    return null;
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  const upper = q.toUpperCase();

  for (const r of results) {
    const openfda = r.openfda || {};
    const generics = Array.isArray(openfda.generic_name) ? openfda.generic_name.map(x => String(x).toUpperCase()) : [];

    if (generics.length !== 1) continue;
    if (generics[0].includes(' AND ') || generics[0].includes(',')) continue;
    if (!generics[0].includes(upper)) continue;

    for (const section of ['indications_and_usage', 'purpose', 'description']) {
      const arr = r[section];
      const text = Array.isArray(arr) && arr.length ? String(arr[0]).trim() : '';
      if (text && text.length > 40) {
        return {
          text: text.slice(0, 4000),
          labelName: generics[0],
          section
        };
      }
    }
  }
  return null;
}

async function summarizeFdaLabel(openaiKey, canonical, label) {
  if (!openaiKey || !label || !label.text) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content: [
              'You rewrite an official FDA drug label extract into plain English for a patient.',
              '',
              'Use ONLY the label text supplied by the user. Never add facts from your own knowledge.',
              'If the text does not make the purpose clear, reply with exactly: NONE',
              '',
              'Write 2-3 short sentences, 35-60 words total, describing what the medication is and',
              'what it is used for. Neutral and factual.',
              'Do NOT include dosing instructions, specific side effects, drug interactions, or advice.',
              'Do not mention a brand name unless the label names it as the drug itself.',
              'Do not say "the label states" — just describe the medication. End with a complete sentence.',
              'Reply with the sentences only. No preamble, no markdown.'
            ].join('\n')
          },
          { role: 'user', content: `Medication: ${canonical}\n\nFDA label extract:\n${label.text}` }
        ]
      })
    });
    if (!resp.ok) {
      console.warn('[FDA] summariser returned', resp.status);
      return null;
    }
    const data = await resp.json();
    let out = (data?.choices?.[0]?.message?.content || '').trim();
    if (!out || out.toUpperCase().startsWith('NONE')) return null;
    if (out.length > 500) out = out.slice(0, 500);
    return out;
  } catch (e) {
    console.warn('[FDA] summariser failed:', e.message);
    return null;
  }
}

function normalizeMedKey(raw) {
  const base = String(raw || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
  return base ? `${base}__${MED_IMAGE_CACHE_VERSION}` : '';
}

function isAllowedImageHost(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    for (const allowed of MED_IMAGE_HOST_ALLOWLIST) {
      if (host === allowed || host.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

exports.cleanMedicationImageCache = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule('0 4 * * *')
  .timeZone('UTC')
  .onRun(async () => {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - MED_IMAGE_CACHE_TTL_MS);
    let deleted = 0;

    try {
      for (;;) {
        const snap = await db.collection('medicationImageCache')
          .where('fetchedAt', '<', cutoff)
          .limit(400)
          .get();
        if (snap.empty) break;

        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;

        if (snap.size < 400) break;
      }
      console.log(`[cacheSweep] removed ${deleted} expired medicationImageCache entr${deleted === 1 ? 'y' : 'ies'}`);
    } catch (e) {
      console.error('[cacheSweep] failed:', e.message);
    }
    return null;
  });

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
      const caller = await requireVerifiedCaller(req);
      if (!caller.ok) { res.status(caller.status).json({ error: caller.error }); return; }

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

      try {
        const cacheSnap = await cacheRef.get();
        if (cacheSnap.exists) {
          const c = cacheSnap.data() || {};
          const fetchedAtMs = (c.fetchedAt && c.fetchedAt.toMillis) ? c.fetchedAt.toMillis() : 0;
          const ageMs = Date.now() - fetchedAtMs;
          if (fetchedAtMs > 0 && ageMs < MED_IMAGE_CACHE_TTL_MS) {
            cacheRef.update({ hitCount: admin.firestore.FieldValue.increment(1), lastHitAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
            res.status(200).json({
              isMed: !!c.isMed,
              canonical: c.canonical || null,
              genericName: c.genericName || null,
              form: c.form || null,
              summary: c.summary || null,
              summarySource: c.summarySource || null,
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

      const quota = await consumeAiQuota(caller.uid, 'medLookup', AI_DAILY_LIMITS.medLookup);
      if (!quota.allowed) {
        res.status(200).json({
          isMed: false, canonical: null, genericName: null, form: null,
          summary: null, imageUrl: null, source: 'none', cachedAt: null
        });
        return;
      }

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      let validator = { isMed: false, canonical: null, genericName: null, form: null, summary: null };
      try {
        const sys = "You are a strict medication name validator. The user types a free-form string. Decide if it's a real prescription drug, a recognized OTC medication (e.g. ibuprofen, acetaminophen, loratadine, melatonin, aspirin), or a recognized supplement/vitamin used in daily reminder schedules (e.g. Vitamin D, Vitamin B12, Fish Oil, Iron, Magnesium). Reject pure non-medical words, foods, brand jokes, or random text. Tolerate common misspellings (e.g. 'metforminn' -> 'Metformin').\n\nRespond with STRICT JSON only, no prose. Schema: { \"isMed\": boolean, \"canonical\": string|null, \"genericName\": string|null, \"form\": \"tablet\"|\"capsule\"|\"liquid\"|\"injection\"|\"patch\"|\"inhaler\"|\"cream\"|\"other\"|null }.\n\nRules:\n- canonical: canonical capitalization (e.g. 'Metformin', 'Vitamin D').\n- genericName: active ingredient if the user typed a brand (e.g. 'Lipitor' -> 'Atorvastatin'). Otherwise null.\n- If isMed is false, set every other field to null.";
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
          } catch (e) {
            console.warn('[lookupMedicationImage] LLM JSON parse failed:', e.message, raw.slice(0, 200));
          }
        }
      } catch (e) {
        console.warn('[lookupMedicationImage] OpenAI call failed:', e.message);
      }

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

      try {
        const candidates = [validator.genericName, validator.canonical].filter(Boolean);
        let label = null;
        for (const c of candidates) {
          label = await fetchFdaLabel(c);
          if (label) break;
        }
        if (label) {
          validator.summary = await summarizeFdaLabel(openaiKey, validator.canonical, label);
          if (validator.summary) validator.summarySource = `FDA label (${label.labelName})`;
        } else {
          console.log(`[FDA] no single-ingredient label for ${validator.canonical} — omitting summary`);
        }
      } catch (e) {
        console.warn('[FDA] summary step failed:', e.message);
      }

      const serperKey = functions.config().serper?.api_key;
      let imageUrl = null;
      if (serperKey) {
        try {
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
            if (!imageUrl && candidates.length > 0) {
              const hosts = candidates.slice(0, 5).map(c => {
                try { return new URL(c.imageUrl || c.thumbnailUrl).hostname; } catch (_) { return '?'; }
              });
              console.log(`[lookupMedicationImage] no allowlisted image for "${validator.canonical}" among: ${hosts.join(', ')}`);
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

      try {
        await cacheRef.set({
          isMed: true,
          canonical: validator.canonical,
          genericName: validator.genericName,
          form: validator.form,
          summary: validator.summary,
          summarySource: validator.summarySource || null,
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
        summarySource: validator.summarySource || null,
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
      const caller = await requireVerifiedCaller(req);
      if (!caller.ok) { res.status(caller.status).json({ error: caller.error }); return; }

      const quota = await consumeAiQuota(caller.uid, 'imageExtract', AI_DAILY_LIMITS.imageExtract);
      if (!quota.allowed) {
        res.status(429).json({ error: 'Daily scan limit reached. Please try again tomorrow.' });
        return;
      }

      const images = Array.isArray(req.body && req.body.images) ? req.body.images : [];
      if (images.length === 0) { res.status(400).json({ error: 'No images provided' }); return; }
      if (images.length > 5) { res.status(400).json({ error: 'Maximum 5 images per extraction' }); return; }
      for (const img of images) {
        if (typeof img !== 'string') { res.status(400).json({ error: 'Each image must be a base64 data URI string' }); return; }
        if (!img.startsWith('data:image/')) { res.status(400).json({ error: 'Each image must be a base64 image data URI (data:image/...)' }); return; }
        if (img.length > 7 * 1024 * 1024 * 4 / 3) { res.status(400).json({ error: 'One or more images exceed the 7 MB limit' }); return; }
      }

      const openaiKey = functions.config().openai?.key;
      if (!openaiKey) { res.status(500).json({ error: 'OpenAI API key not configured' }); return; }

      const today = await callerLocalDate(caller.uid);
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
            max_tokens: 1800,
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

      console.log(`[extractMedicationFromImages] ok: ${out.imageCount} image(s), name=${out.name ? 'yes' : 'no'}, schedules=${out.schedules ? out.schedules.length : 0} (uid=${caller.uid})`);
      res.status(200).json(out);
    } catch (error) {
      console.error('[extractMedicationFromImages] error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });
});


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

    if (!storedTimezone || storedTimezone === detectedTimezone) {
      res.status(200).json({ message: 'No timezone change detected', changed: false });
      return;
    }

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

    const requestRef = dbRef.collection('users').doc(uid).collection('timezoneRequests').doc();
    await requestRef.set({
      originalTimezone: storedTimezone,
      newTimezone: detectedTimezone,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userEmail = userData.email;
    const userName = userData.name || 'there';

    if (userEmail) {
      const link = `${APP_BASE_URL}/traveltimezone.html?request=${requestRef.id}`;

      const safeUserName = escapeHtml(userName);
      const safeStoredTz = escapeHtml(storedTimezone);
      const safeDetectedTz = escapeHtml(detectedTimezone);

      const msg = {
        to: userEmail,
        from: `Everane <${gmailEmail}>`,
        subject: 'Did you change timezones?',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #0b1020; color: #e7ebf3;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="font-size: 1.6rem; margin: 0; color: #4f8cff;">Timezone Change Detected</h1>
            </div>
            <p style="font-size: 1rem; line-height: 1.6; color: #e7ebf3;">Hi ${safeUserName},</p>
            <p style="font-size: 1rem; line-height: 1.6; color: #b1bad4;">We noticed you may have traveled or changed timezones.</p>
            <div style="background: #0f1629; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 16px 20px; margin: 20px 0;">
              <p style="margin: 0 0 8px; color: #b1bad4; font-size: 0.9rem;">Current timezone on file:</p>
              <p style="margin: 0 0 16px; color: #e7ebf3; font-weight: 700; font-size: 1.05rem;">${safeStoredTz}</p>
              <p style="margin: 0 0 8px; color: #b1bad4; font-size: 0.9rem;">Detected timezone:</p>
              <p style="margin: 0; color: #7de2d1; font-weight: 700; font-size: 1.05rem;">${safeDetectedTz}</p>
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

      await withRetry(
        `requestTimezoneChangeEmail->${userEmail}`,
        () => transporter.sendMail(msg),
        3,
        750
      );
      console.log(`[Timezone] Sent timezone change email to ${userEmail} (${storedTimezone} -> ${detectedTimezone})`);
    }

    res.status(200).json({ message: 'Timezone change email sent', changed: true, requestId: requestRef.id });
  } catch (error) {
    console.error('[Timezone] requestTimezoneChangeEmail error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

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

    if (action === 'change') {
      await dbRef.collection('users').doc(uid).set({
        timezone: requestData.newTimezone
      }, { merge: true });
      console.log(`[Timezone] User ${uid} changed timezone: ${requestData.originalTimezone} -> ${requestData.newTimezone}`);
    } else {
      console.log(`[Timezone] User ${uid} chose to stay at: ${requestData.originalTimezone}`);
    }

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

      const medsSnap = await db.collection('users').doc(userDoc.id).collection('medications').get();
      const medications = [];
      const dayMap = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

      function toDateStr(val) {
        if (!val) return null;
        if (val.toDate) return val.toDate().toISOString();
        if (val._seconds) return new Date(val._seconds * 1000).toISOString();
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
            if (s.startDate) {
              const sd = toDateStr(s.startDate);
              if (sd) d._startDate = d._startDate || sd;
            }
          });
        }

        const times = [...timesSet].sort();
        const days = [...daysSet];

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

      const doctorToken = issueDoctorToken(userDoc.id);
      res.status(200).json({
        success: true,
        uid: userDoc.id,
        doctorToken,
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

exports.submitDoctorEdit = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const sessionUid = requireDoctorSession(req);
      if (!sessionUid) {
        res.status(401).json({ error: 'Doctor session expired. Please log in again.' });
        return;
      }
      const { type, details, doctorName } = req.body;
      const uid = sessionUid;

      if (!uid || !type || !details) {
        res.status(400).json({ error: 'uid, type, and details are required.' });
        return;
      }

      const db = admin.firestore();

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

exports.getDoctorEdits = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const sessionUid = requireDoctorSession(req);
      if (!sessionUid) {
        res.status(401).json({ error: 'Doctor session expired. Please log in again.' });
        return;
      }
      const uid = sessionUid;

      if (!uid) {
        res.status(400).json({ error: 'uid is required.' });
        return;
      }

      const db = admin.firestore();

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

exports.replyToDoctorEdit = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const sessionUid = requireDoctorSession(req);
      if (!sessionUid) {
        res.status(401).json({ error: 'Doctor session expired. Please log in again.' });
        return;
      }
      const { editId, message, doctorName } = req.body;
      const uid = sessionUid;

      if (!uid || !editId || !message) {
        res.status(400).json({ error: 'uid, editId, and message are required.' });
        return;
      }

      const db = admin.firestore();

      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().doctorPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

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

exports.listMyPushSubscriptions = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  const uid = context.auth.uid;
  const hereEndpoint = (data && data.hereEndpoint) || null;
  const db = admin.firestore();
  const snap = await db.collection('users').doc(uid).get();
  const subs = (snap.exists ? (snap.data().pushSubscriptions || []) : []).filter(Boolean);

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
      const d = parts[parts.length - 2];
      if (isoDate.test(d) && d !== todayIso) {
        removedStale.push(key);
        delete lastSent[key];
      }
    } else if (isoDate.test(last)) {
      removedLegacy.push(key);
      delete lastSent[key];
    } else {
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

        let deliveryReport = null;
        if (sid) {
          await new Promise(r => setTimeout(r, 6000));
          deliveryReport = await getSmsDeliveryStatus(sid, userPhoneNumber);
        }

        let carrierFailed = false;
        if (deliveryReport && !deliveryReport.error) {
          const status = String(deliveryReport.status || '').toLowerCase();
          if (status === 'failed' || status === 'undelivered') {
            carrierFailed = true;
          }
        }

        const smsReason = carrierFailed
          ? `carrier-rejected (status=${deliveryReport && deliveryReport.status}, code=${deliveryReport && deliveryReport.code})`
          : (deliveryReport && deliveryReport.error ? 'no-delivery-report' : null);

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

