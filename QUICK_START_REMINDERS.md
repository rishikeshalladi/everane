# 🚀 Quick Start: Email Reminders

## What You Get

✅ **Automatic email reminders** for medications based on your schedule  
✅ **30-minute advance reminders** (if you set specific times)  
✅ **Daily low stock alerts** at 9 AM  
✅ **Smart scheduling** based on your settings  

---

## ⚡ 5-Minute Setup

### 1. Install Firebase CLI
```bash
npm install -g firebase-tools
firebase login
```

### 2. Install Function Dependencies
```bash
cd /Users/rishikeshalladi/Documents/MedTracker/functions
npm install
```

### 3. Set Up Gmail App Password

1. **Enable 2FA** on your Google account:  
   → https://myaccount.google.com/security

2. **Generate App Password**:  
   → https://myaccount.google.com/apppasswords  
   → Select "Mail" and "Other"  
   → Copy the 16-character code

3. **Configure Firebase**:
   ```bash
   firebase functions:config:set gmail.email="your@gmail.com" gmail.password="abcd-efgh-ijkl-mnop"
   ```

### 4. Set Your Timezone

Edit `functions/index.js` (lines 176 & 270):
```javascript
.timeZone('America/New_York') // Change to your timezone
```

### 5. Deploy
```bash
firebase deploy --only functions
```

---

## 📅 How It Works

### Reminder Schedule

| Your Setting | Emails Sent At |
|-------------|----------------|
| Custom times (e.g., 8 AM, 6 PM) | 8:00 AM, 6:00 PM + 30-min before each |
| No time, 1/day | 9:00 AM |
| No time, 2/day | 9:00 AM, 9:00 PM |
| No time, 3/day | 9:00 AM, 3:00 PM, 9:00 PM |
| No time, 4+/day | 9:00 AM, 3:00 PM, 9:00 PM (max 3) |

### When You DON'T Get Reminders

- End date passed ❌
- Medication deleted ❌
- Not scheduled for today ❌
- Reminder = "None" or "SMS" ❌
- Stock empty (refill alert only) 📦

---

## 🧪 Test It

1. **Add a test medication** in MedTracker:
   - Name: "Test Med"
   - Reminder: Email
   - Time: 5 minutes from now
   - Days: Today

2. **Wait 5 minutes** and check your email

3. **Check logs**:
   ```bash
   firebase functions:log
   ```

---

## 📧 Sample Email

```
Subject: Medication Reminder: Aspirin

💊 Medication Reminder
Time to take your medication

Aspirin
Dosage: 100mg
Time: 9:00 AM
Bottles in stock: 2

✅ Remember to mark this dose as taken in your MedTracker app!

[Open MedTracker]
```

---

## 🎯 Next Steps

- ✅ Deployed? → Test with a real medication
- 📊 Monitor: https://console.firebase.google.com → Functions
- 📝 Customize: Edit `functions/index.js` and redeploy
- 📖 Full docs: See `REMINDER_SETUP.md`

---

## 💡 Pro Tips

1. **Check spam folder** for first few emails
2. **Gmail limit**: 500 emails/day (plenty for personal use)
3. **Cost**: Free for most users (within Firebase free tier)
4. **Logs**: `firebase functions:log` shows all activity

---

## ❓ Troubleshooting

**No emails?**
```bash
# Check config
firebase functions:config:get

# Check logs
firebase functions:log --only sendMedicationReminders

# Redeploy
firebase deploy --only functions
```

**Wrong time?**
- Check timezone in `functions/index.js`
- Must match your location!

**Still stuck?**
- See full guide: `REMINDER_SETUP.md`
- Check Firebase Console → Functions → Logs

