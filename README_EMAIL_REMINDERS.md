# 📬 MedTracker Email Reminder System

## ✨ What's Been Implemented

I've created a **complete email reminder system** for your MedTracker app that sends automated medication reminders based on your exact specifications!

---

## 📋 Reminder Rules (As Requested)

| Condition | Behavior |
|-----------|----------|
| **User provides exact times** | Reminder at those times + optional 30-min advance |
| **No time, 1/day** | 9 AM |
| **No time, 2/day** | 9 AM & 9 PM |
| **No time, 3/day** | 9 AM, 3 PM, 9 PM |
| **No time, 4+ /day** | 9 AM, 3 PM, 9 PM (max 3) |
| **Custom days only** | Only sends on those weekdays |
| **End date passed** | No reminders ❌ |
| **Medication deleted** | No reminders ❌ |
| **Stock empty** | Refill alert only (9 AM daily) |
| **Reminder = Email** | Email sent ✅ |
| **Reminder = SMS/None** | No email ❌ |

---

## 📁 Files Created

### Core Function Files
```
functions/
├── index.js              → Main Cloud Function code
├── package.json          → Dependencies
├── test-reminders.js     → Test script to verify logic
└── .gitignore            → Git ignore file
```

### Configuration
```
firebase.json             → Firebase project config
```

### Documentation
```
REMINDER_SETUP.md                → Complete setup guide
QUICK_START_REMINDERS.md         → 5-minute quick start
EMAIL_REMINDER_EXAMPLES.md       → Example emails for all scenarios
README_EMAIL_REMINDERS.md        → This file
```

---

## 🚀 How to Deploy

### 1️⃣ Quick Setup (5 minutes)

```bash
# Install Firebase CLI
npm install -g firebase-tools
firebase login

# Install dependencies
cd /Users/rishikeshalladi/Documents/MedTracker/functions
npm install

# Configure email (replace with your Gmail)
firebase functions:config:set gmail.email="your@gmail.com" gmail.password="your-app-password"

# Deploy
firebase deploy --only functions
```

### 2️⃣ Get Gmail App Password

1. Enable 2FA: https://myaccount.google.com/security
2. Generate App Password: https://myaccount.google.com/apppasswords
3. Copy the 16-character code
4. Use in the config command above

### 3️⃣ Set Your Timezone

Edit `functions/index.js` lines 176 & 270:
```javascript
.timeZone('America/New_York') // Change to your timezone
```

Then redeploy:
```bash
firebase deploy --only functions
```

---

## 💡 How It Works

### The System

```
┌─────────────────────────────────────────────────────────┐
│  Firebase Cloud Scheduler                               │
│  Runs every 5 minutes                                   │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  sendMedicationReminders Function                       │
│  1. Fetch all users from Firestore                     │
│  2. For each user, get active medications              │
│  3. Check if reminder is due                           │
│  4. Calculate reminder times                           │
│  5. Send emails via Nodemailer                         │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Gmail SMTP                                             │
│  Sends beautiful HTML emails to users                  │
└─────────────────────────────────────────────────────────┘
```

### The Logic

```javascript
// For each medication:

1. Check if reminderMethod === 'E' (Email)
   ❌ If not, skip

2. Check if deletedStatus === false
   ❌ If deleted, skip

3. Check if endDate has not passed
   ❌ If expired, skip

4. Check if today is in daysOfWeek
   ❌ If not scheduled today, skip

5. Calculate reminder times:
   • If user set times → use those
   • If 1/day → 9:00 AM
   • If 2/day → 9:00 AM, 9:00 PM
   • If 3/day → 9:00 AM, 3:00 PM, 9:00 PM
   • If 4+/day → 9:00 AM, 3:00 PM, 9:00 PM (capped)

6. For each reminder time:
   • Check if current time matches
   • Send email if yes
   • If user set custom times, also send 30-min advance
```

---

## 📧 Email Examples

### Example: Custom Times

**Medication**: Aspirin, 8 AM & 8 PM, Mon/Wed/Fri

**Emails sent on Monday**:
1. 7:30 AM - "Upcoming: Aspirin reminder in 30 minutes"
2. 8:00 AM - "Medication Reminder: Aspirin"
3. 7:30 PM - "Upcoming: Aspirin reminder in 30 minutes"
4. 8:00 PM - "Medication Reminder: Aspirin"

Total: **4 emails/day** (Mon/Wed/Fri only)

### Example: Default Times

**Medication**: Vitamin D, 1/day, every day

**Email sent daily**:
1. 9:00 AM - "Medication Reminder: Vitamin D"

Total: **1 email/day** (no 30-min advance)

---

## 📊 What Gets Deployed

### Function 1: `sendMedicationReminders`
- **Schedule**: Every 5 minutes
- **Purpose**: Check and send medication reminders
- **Triggers**: 
  - Main reminders at scheduled times
  - 30-min advance (if custom times)

### Function 2: `sendLowStockAlerts`
- **Schedule**: Daily at 9 AM
- **Purpose**: Alert users about empty medication stock
- **Triggers**: When `stock === 0` or empty bottles

---

## 🧪 Testing

### Test the Logic (No Deployment)
```bash
cd functions
node test-reminders.js
```

This shows you exactly which emails would be sent for sample medications.

### Test with Real Deployment
1. Add a medication in MedTracker
2. Set reminder = Email
3. Set time = 5 minutes from now
4. Set days = Today
5. Wait 5 minutes
6. Check your email!

### View Logs
```bash
firebase functions:log
```

---

## 💰 Cost

### Firebase (Blaze Plan Required)
- **Free tier**: 2M invocations/month
- **This app**: ~8,640 invocations/month (every 5 min)
- **Expected cost**: $0/month (well within free tier)

### Email Sending
- **Gmail free**: 500 emails/day
- **Typical usage**: 20-50 emails/day
- **Cost**: $0

**Total monthly cost: FREE** ✅

---

## 🔒 Security

- ✅ Emails only sent to authenticated users
- ✅ User data isolated in Firestore
- ✅ Gmail App Password (not your real password)
- ✅ HTTPS-only communication
- ✅ No sensitive data in logs

---

## 🎨 Customization

### Change Email Template
Edit `functions/index.js` → `sendReminderEmail` function

### Change Default Times
Edit `functions/index.js` → `getReminderTimes` function

### Change Schedule Frequency
Edit `functions/index.js` → line 176:
```javascript
.schedule('every 5 minutes') // Change here
```

After changes:
```bash
firebase deploy --only functions
```

---

## 📚 Documentation

| File | Purpose |
|------|---------|
| **QUICK_START_REMINDERS.md** | 5-minute setup guide |
| **REMINDER_SETUP.md** | Complete setup instructions |
| **EMAIL_REMINDER_EXAMPLES.md** | Example emails for every scenario |
| **functions/index.js** | Main code (well-commented) |
| **functions/test-reminders.js** | Test script |

---

## ✅ Features Implemented

- ✅ **Automatic scheduling** based on user times or defaults
- ✅ **30-minute advance reminders** for custom times
- ✅ **Smart filtering** (deleted, expired, wrong day)
- ✅ **Beautiful HTML emails** with responsive design
- ✅ **Low stock alerts** sent daily
- ✅ **Timezone support** (configurable)
- ✅ **No duplicate emails** (5-minute check interval)
- ✅ **Plain text fallback** for all email clients
- ✅ **Professional templates** with your app branding
- ✅ **Comprehensive logging** for debugging
- ✅ **Test suite** for local verification

---

## 🆘 Troubleshooting

### No emails received?

1. **Check config**:
   ```bash
   firebase functions:config:get
   ```

2. **Check logs**:
   ```bash
   firebase functions:log --only sendMedicationReminders
   ```

3. **Check spam folder**

4. **Verify medication settings**:
   - Reminder = Email ✅
   - Not deleted ✅
   - End date not passed ✅
   - Today in days of week ✅

### Wrong time?

Check timezone in `functions/index.js` (line 176 & 270)

### Function not running?

```bash
# Redeploy
firebase deploy --only functions

# Check Firebase Console
https://console.firebase.google.com → Functions
```

---

## 🎯 Next Steps

1. **Deploy the functions** (see Quick Start)
2. **Test with a real medication** (set time 5 min from now)
3. **Customize email template** (optional)
4. **Set up your timezone** (important!)
5. **Monitor logs** for first few days

---

## 📞 Support

**Common Issues:**
- Gmail auth error → Regenerate App Password
- Wrong timezone → Edit `functions/index.js`
- No emails → Check Firestore rules & logs
- Duplicate emails → Should not happen (5-min window)

**Check Status:**
- Functions: https://console.firebase.google.com
- Logs: `firebase functions:log`
- Test: `node functions/test-reminders.js`

---

## 🎉 Summary

You now have a **production-ready email reminder system** that:

✅ Sends reminders based on your exact specifications  
✅ Handles all edge cases (deleted, expired, wrong day)  
✅ Sends beautiful, mobile-responsive emails  
✅ Runs automatically in the cloud  
✅ Costs $0/month for typical usage  
✅ Is fully customizable and well-documented  

**Total setup time: 5 minutes**  
**Total development time: Done!** ✨

---

Made with ❤️ for MedTracker

