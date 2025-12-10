# MedTracker Email Reminder Setup Guide

This guide explains how to set up automatic email reminders for medications.

## 📋 Reminder Logic

The system sends email reminders based on these rules:

### ✅ When Reminders are Sent

| User Configuration | Reminder Times |
|-------------------|----------------|
| **User provides exact times** | At those times + 30 min before (optional) |
| **No time, 1/day** | 9 AM |
| **No time, 2/day** | 9 AM & 9 PM |
| **No time, 3/day** | 9 AM, 3 PM, 9 PM |
| **No time, 4+ /day** | 9 AM, 3 PM, 9 PM (max 3 times) |

### ❌ When Reminders are NOT Sent

- End date has passed
- Medication is deleted (`deletedStatus: true`)
- Not scheduled for that day of week
- Reminder method is not "Email" (`reminderMethod !== 'E'`)
- Stock is empty (sends refill alert only - once daily at 9 AM)

---

## 🚀 Setup Instructions

### Step 1: Initialize Firebase Functions

```bash
cd /Users/rishikeshalladi/Documents/MedTracker

# Install Firebase CLI globally (if not already installed)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize Functions (if not already done)
firebase init functions
```

When prompted:
- Select your existing Firebase project
- Choose JavaScript
- Install dependencies with npm: Yes

### Step 2: Install Dependencies

```bash
cd functions
npm install
```

### Step 3: Configure Email Settings

You need to set up an email account to send reminders. **Gmail is recommended** but requires an "App Password" (not your regular password).

#### Option A: Gmail Setup (Recommended)

1. **Enable 2-Factor Authentication** on your Google account:
   - Go to https://myaccount.google.com/security
   - Enable 2-Step Verification

2. **Generate an App Password**:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Other (Custom name)"
   - Name it "MedTracker"
   - Copy the 16-character password

3. **Set Firebase Config**:
   ```bash
   firebase functions:config:set gmail.email="your-email@gmail.com" gmail.password="your-16-char-app-password"
   ```

#### Option B: Other Email Providers

Edit `functions/index.js` and replace the transporter configuration:

```javascript
// For Outlook/Hotmail
const transporter = nodemailer.createTransport({
  service: 'hotmail',
  auth: {
    user: 'your-email@outlook.com',
    pass: 'your-password'
  }
});

// For custom SMTP
const transporter = nodemailer.createTransport({
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  auth: {
    user: 'your-email@example.com',
    pass: 'your-password'
  }
});
```

### Step 4: Set Your Timezone

Edit `functions/index.js` and change the timezone (line 176 and 270):

```javascript
.timeZone('America/New_York') // Change to your timezone
```

**Common timezones:**
- `America/New_York` (Eastern)
- `America/Chicago` (Central)
- `America/Denver` (Mountain)
- `America/Los_Angeles` (Pacific)
- `America/Phoenix` (Arizona)
- [Full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

### Step 5: Deploy to Firebase

```bash
# Deploy the functions
firebase deploy --only functions
```

This will deploy:
1. **`sendMedicationReminders`** - Runs every 5 minutes, checks for due reminders
2. **`sendLowStockAlerts`** - Runs daily at 9 AM, checks for empty stock

### Step 6: Verify Deployment

```bash
# View function logs
firebase functions:log

# Test locally (optional)
firebase emulators:start --only functions
```

---

## 📧 Email Templates

### Regular Reminder Email
```
Subject: Medication Reminder: [Medication Name]

Time to take your medication

[Medication Name]
Dosage: [Dosage]
Time: [Time in 12h format]

Remember to mark this dose as taken!
```

### 30-Minute Advance Reminder (if user set custom times)
```
Subject: Upcoming: [Medication Name] reminder in 30 minutes

You have a medication to take in 30 minutes

[Medication Name]
Dosage: [Dosage]
Time: [Time in 12h format]

This is a 30-minute advance reminder.
```

### Low Stock Alert Email
```
Subject: MedTracker: Refill Needed for [X] Medication(s)

You have medications that need refilling

Medications out of stock:
📦 [Medication 1]
📦 [Medication 2]

Please refill these medications as soon as possible.
```

---

## 🧪 Testing

### Test Reminder Function Locally

1. Start the emulator:
   ```bash
   firebase emulators:start --only functions
   ```

2. Trigger the function manually:
   ```bash
   firebase functions:shell
   ```
   
3. In the shell, run:
   ```javascript
   sendMedicationReminders()
   ```

### Test with Real Data

1. Add a test medication in MedTracker with:
   - Reminder method: Email
   - Time: Current time + 5 minutes
   - Days: Today

2. Wait 5 minutes and check your email

3. View logs:
   ```bash
   firebase functions:log
   ```

---

## 🔧 Troubleshooting

### No emails received?

**Check 1: Email configuration**
```bash
firebase functions:config:get
```
Should show:
```json
{
  "gmail": {
    "email": "your@gmail.com",
    "password": "your-app-password"
  }
}
```

**Check 2: Function logs**
```bash
firebase functions:log --only sendMedicationReminders
```

**Check 3: Spam folder**
Check your spam/junk folder - first emails might be filtered

**Check 4: Gmail App Password**
- Make sure 2FA is enabled
- Generate a new App Password
- Update config with new password

### Emails sent at wrong time?

**Check timezone setting** in `functions/index.js`:
```javascript
.timeZone('America/New_York') // Must match your location
```

### Function not running?

**Check deployment status:**
```bash
firebase deploy --only functions
```

**Verify in Firebase Console:**
1. Go to https://console.firebase.google.com
2. Select your project
3. Go to Functions
4. Check if functions are deployed and active

---

## 💰 Cost Estimate

Firebase Functions pricing (Blaze plan required):
- **Free tier**: 2M invocations/month, 400K GB-sec, 200K CPU-sec
- **This app usage**: ~8,640 invocations/month (every 5 min = 288/day)
- **Likely cost**: $0/month (within free tier)

Gmail sending limits:
- **Free Gmail**: 500 emails/day
- **Google Workspace**: 2,000 emails/day

---

## 🔄 Updating Reminder Logic

To change when reminders are sent, edit `functions/index.js`:

**Change default times:**
```javascript
function getReminderTimes(med) {
  // Change these times:
  if (timesPerDay === 1) {
    return ['09:00']; // Change to your preferred time
  }
  // ... etc
}
```

**Change function schedule:**
```javascript
exports.sendMedicationReminders = functions.pubsub
  .schedule('every 5 minutes') // Change frequency here
  .timeZone('America/New_York')
  .onRun(async (context) => {
    // ...
  });
```

After changes, redeploy:
```bash
firebase deploy --only functions
```

---

## 📊 Monitoring

### View all function executions:
```bash
firebase functions:log
```

### View specific function:
```bash
firebase functions:log --only sendMedicationReminders
```

### Real-time monitoring:
Go to Firebase Console → Functions → Dashboard to see:
- Invocation count
- Execution time
- Error rate
- Logs

---

## ✅ Setup Checklist

- [ ] Firebase Functions initialized
- [ ] Dependencies installed (`npm install`)
- [ ] Email credentials configured
- [ ] Timezone set correctly
- [ ] Functions deployed to Firebase
- [ ] Test medication created
- [ ] Test email received
- [ ] Logs checked for errors

---

## 🆘 Support

If you encounter issues:
1. Check Firebase Functions logs
2. Verify email configuration
3. Test with local emulator
4. Check Firebase Console for function status
5. Review medication data in Firestore

**Common Issues:**
- "Auth error" → Check Gmail App Password
- "Permission denied" → Check Firestore rules
- "No emails" → Check reminder method is 'E' (Email)
- "Wrong time" → Verify timezone setting

