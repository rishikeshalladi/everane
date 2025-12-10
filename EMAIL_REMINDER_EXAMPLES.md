# 📧 Email Reminder Examples

This document shows exactly what emails will be sent based on different medication configurations.

---

## Example 1: Custom Times with 30-Min Advance

### Medication Configuration:
- **Name**: Aspirin
- **Dosage**: 100mg
- **Times**: 8:00 AM, 8:00 PM (user provided)
- **Days**: Monday, Wednesday, Friday
- **Reminder**: Email

### Emails Sent (on Monday/Wednesday/Friday):

#### 7:30 AM (30-min advance)
```
From: MedTracker <medtracker@gmail.com>
To: user@example.com
Subject: Upcoming: Aspirin reminder in 30 minutes

💊 Upcoming Medication Reminder
You have a medication to take in 30 minutes

Aspirin
Dosage: 100mg
Time: 8:00 AM

⏰ This is a 30-minute advance reminder.
You'll receive another reminder at the scheduled time.

[Open MedTracker]
```

#### 8:00 AM (main reminder)
```
From: MedTracker <medtracker@gmail.com>
To: user@example.com
Subject: Medication Reminder: Aspirin

💊 Medication Reminder
Time to take your medication

Aspirin
Dosage: 100mg
Time: 8:00 AM
Bottles in stock: 2

✅ Remember to mark this dose as taken in your MedTracker app!

[Open MedTracker]
```

#### 7:30 PM (30-min advance)
```
Subject: Upcoming: Aspirin reminder in 30 minutes
[Same format as above, but for 8:00 PM]
```

#### 8:00 PM (main reminder)
```
Subject: Medication Reminder: Aspirin
[Same format as above, but for 8:00 PM]
```

**Total emails per day (Mon/Wed/Fri): 4**  
**Total emails per week: 12**

---

## Example 2: No Custom Times, 1 Per Day

### Medication Configuration:
- **Name**: Vitamin D
- **Dosage**: 1000 IU
- **Times**: (none provided)
- **Times Per Day**: 1
- **Days**: All days
- **Reminder**: Email

### Emails Sent (every day):

#### 9:00 AM (default time)
```
From: MedTracker <medtracker@gmail.com>
To: user@example.com
Subject: Medication Reminder: Vitamin D

💊 Medication Reminder
Time to take your medication

Vitamin D
Dosage: 1000 IU
Time: 9:00 AM
Bottles in stock: 1

✅ Remember to mark this dose as taken in your MedTracker app!

[Open MedTracker]
```

**Total emails per day: 1**  
**Total emails per week: 7**  
**No 30-min advance** (user didn't set custom times)

---

## Example 3: No Custom Times, 2 Per Day

### Medication Configuration:
- **Name**: Blood Pressure Med
- **Dosage**: 50mg
- **Times**: (none provided)
- **Times Per Day**: 2
- **Days**: All days
- **Reminder**: Email

### Emails Sent (every day):

#### 9:00 AM
```
Subject: Medication Reminder: Blood Pressure Med
Time: 9:00 AM
```

#### 9:00 PM
```
Subject: Medication Reminder: Blood Pressure Med
Time: 9:00 PM
```

**Total emails per day: 2**  
**Total emails per week: 14**  
**No 30-min advance**

---

## Example 4: No Custom Times, 3 Per Day

### Medication Configuration:
- **Name**: Antibiotic
- **Dosage**: 250mg
- **Times**: (none provided)
- **Times Per Day**: 3
- **Days**: All days
- **Reminder**: Email

### Emails Sent (every day):

#### 9:00 AM
```
Subject: Medication Reminder: Antibiotic
Time: 9:00 AM
```

#### 3:00 PM
```
Subject: Medication Reminder: Antibiotic
Time: 3:00 PM
```

#### 9:00 PM
```
Subject: Medication Reminder: Antibiotic
Time: 9:00 PM
```

**Total emails per day: 3**  
**Total emails per week: 21**  
**No 30-min advance**

---

## Example 5: No Custom Times, 4+ Per Day

### Medication Configuration:
- **Name**: Frequent Med
- **Dosage**: 10mg
- **Times**: (none provided)
- **Times Per Day**: 5 (or any number > 3)
- **Days**: All days
- **Reminder**: Email

### Emails Sent (every day):

Uses the 3-times schedule (max):

#### 9:00 AM
```
Subject: Medication Reminder: Frequent Med
```

#### 3:00 PM
```
Subject: Medication Reminder: Frequent Med
```

#### 9:00 PM
```
Subject: Medication Reminder: Frequent Med
```

**Total emails per day: 3** (capped at 3)  
**Total emails per week: 21**

---

## Example 6: Custom Days Only

### Medication Configuration:
- **Name**: Weekend Vitamin
- **Dosage**: 500mg
- **Times**: 10:00 AM (custom)
- **Days**: Saturday, Sunday only
- **Reminder**: Email

### Emails Sent:

#### Saturday & Sunday at 9:30 AM (30-min advance)
```
Subject: Upcoming: Weekend Vitamin reminder in 30 minutes
Time: 10:00 AM
```

#### Saturday & Sunday at 10:00 AM
```
Subject: Medication Reminder: Weekend Vitamin
Time: 10:00 AM
```

**Monday-Friday: No emails**  
**Saturday-Sunday: 4 emails total (2 per day)**

---

## Example 7: Low Stock Alert

### Trigger:
- Medication has `stock: 0` or empty bottles array
- Sent once daily at 9:00 AM

### Email:

```
From: MedTracker <medtracker@gmail.com>
To: user@example.com
Subject: MedTracker: Refill Needed for 2 Medications

⚠️ Medication Refill Alert
You have medications that need refilling

Medications out of stock:
📦 Aspirin
📦 Blood Pressure Med

Please refill these medications as soon as possible.

[Open MedTracker]
```

**Sent: Once daily at 9 AM (if any meds are out of stock)**

---

## Example 8: End Date Passed

### Medication Configuration:
- **Name**: Expired Med
- **End Date**: 01/01/2024 (in the past)
- **Reminder**: Email

### Emails Sent:
**❌ NONE** - End date has passed

---

## Example 9: Deleted Medication

### Medication Configuration:
- **Name**: Deleted Med
- **Deleted Status**: true
- **Reminder**: Email

### Emails Sent:
**❌ NONE** - Medication is deleted

---

## Example 10: SMS or No Reminder

### Medication Configuration:
- **Name**: No Email Med
- **Reminder**: SMS or None

### Emails Sent:
**❌ NONE** - Reminder method is not Email

---

## 📊 Summary Table

| Configuration | Emails Per Day | 30-Min Advance? |
|--------------|----------------|-----------------|
| Custom times (e.g., 8 AM, 6 PM) | 2 | ✅ Yes (4 total) |
| No time, 1/day | 1 | ❌ No |
| No time, 2/day | 2 | ❌ No |
| No time, 3/day | 3 | ❌ No |
| No time, 4+/day | 3 (max) | ❌ No |
| Custom days only | Varies | ✅ Yes (if custom times) |
| End date passed | 0 | ❌ N/A |
| Deleted | 0 | ❌ N/A |
| Stock empty | 0 (refill alert only) | ❌ N/A |

---

## 🔔 Notification Schedule

The Cloud Function runs **every 5 minutes** to check for due reminders.

### Example Timeline (for 9:00 AM reminder):

- **8:55 AM** - Function runs, checks all meds
- **9:00 AM** - Function runs, finds reminder due, sends email
- **9:05 AM** - Function runs again (no duplicate sent)

### 30-Minute Advance Example (for 8:00 AM custom time):

- **7:25 AM** - Function runs, nothing due yet
- **7:30 AM** - Function runs, sends 30-min advance email
- **7:35 AM** - Function runs (no duplicate)
- **7:55 AM** - Function runs, nothing due yet
- **8:00 AM** - Function runs, sends main reminder email
- **8:05 AM** - Function runs (no duplicate)

---

## 💰 Email Volume Examples

### Light User
- 2 medications
- 1 per day each
- Every day

**Emails per week: 14**  
**Emails per month: ~60**

### Moderate User
- 4 medications
- Mix of 1-3 times per day
- Some with custom times

**Emails per week: ~40**  
**Emails per month: ~170**

### Heavy User
- 6 medications
- Multiple times per day
- Custom times with 30-min advance

**Emails per week: ~80**  
**Emails per month: ~350**

**All scenarios are well within Gmail's 500 emails/day limit**

---

## ✉️ Email Format Details

### Email Headers:
- **From**: MedTracker <your-configured-email@gmail.com>
- **To**: User's email from Firebase Auth
- **Reply-To**: (optional - can be configured)

### HTML Email Features:
- ✅ Mobile-responsive design
- ✅ Gradient header with brand colors
- ✅ Clear medication information card
- ✅ Call-to-action button
- ✅ Professional styling
- ✅ Works in all email clients

### Plain Text Fallback:
Every email includes a plain text version for email clients that don't support HTML.

---

## 🎨 Customization

Want to change the email template? Edit `functions/index.js` in the `sendReminderEmail` function:

```javascript
const htmlBody = `
  <!-- Your custom HTML here -->
`;
```

Want to change the sender name? Edit:
```javascript
from: `Your App Name <${gmailEmail}>`,
```

---

## 📱 Mobile Preview

The emails are optimized for mobile devices and will look great on:
- ✅ iPhone Mail
- ✅ Gmail app (iOS/Android)
- ✅ Outlook mobile
- ✅ Any mobile email client

The responsive design ensures the medication card and button are easily readable and tappable on small screens.

