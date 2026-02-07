# Firebase Firestore Structure for MedTracker

## 📊 Database Structure

```
firestore/
└── users/                              (Collection)
    └── {userId}/                       (Document - User's Auth UID)
        ├── email: string
        ├── name: string
        ├── phone: string
        ├── age: number (optional)
        ├── gender: string (optional)
        ├── allergies: string (optional)
        ├── conditions: string (optional)
        ├── medications: string (optional)
        ├── insurance: string (optional)
        ├── emg_name: string (optional)
        ├── emg_phone: string (optional)
        ├── timezone: string
        └── data/                        (Sub-collection)
            ├── medications/             (Document)
            │   ├── medications: array   (list of medication objects)
            │   └── updatedAt: timestamp
            │
            ├── history/                 (Document)
            │   ├── history: array       (list of deleted medication objects)
            │   └── updatedAt: timestamp
            │
            └── notes/                   (Document)
                ├── notes: object        (key-value pairs: "note_YYYY-MM-DD" → note text)
                └── updatedAt: timestamp
```

---

## 📄 Data Examples

### 1. Profile Data (`users/{userId}`)
```json
{
  "email": "user@example.com",
  "name": "John Doe",
  "phone": "+1234567890",
  "age": 35,
  "gender": "Male",
  "allergies": "Penicillin, Peanuts",
  "conditions": "Hypertension",
  "insurance": "Blue Cross",
  "emg_name": "Jane Doe",
  "emg_phone": "+1987654321",
  "timezone": "America/New_York"
}
```

### 2. Medications Data (`users/{userId}/data/medications`)
```json
{
  "medications": [
    {
      "name": "Aspirin",
      "perWeek": "7 days",
      "perDay": "2 times", 
      "dosage": "100mg",
      "stock": 30,
      "frequency": "daily",
      "times": ["08:00", "20:00"],
      "daysOfWeek": [1, 2, 3, 4, 5, 6, 0],
      "startDate": "2025-10-01",
      "endDate": "2025-12-31",
      "notes": "Take with food",
      "color": "#FF6B6B"
    },
    {
      "name": "Vitamin D",
      "perWeek": "7 days",
      "perDay": "1 time",
      "dosage": "1000IU", 
      "stock": 90,
      "frequency": "daily",
      "times": ["09:00"],
      "daysOfWeek": [1, 2, 3, 4, 5, 6, 0],
      "startDate": "2025-10-01",
      "endDate": "",
      "notes": "",
      "color": "#4ECDC4"
    }
  ],
  "updatedAt": "2025-10-11T12:34:56.789Z"
}
```

#### Medication Object Fields:
- **name**: `string` - Medication name (e.g., "Aspirin", "Vitamin D")
- **perWeek**: `string` - How many times per week (e.g., "7 days", "3 times a week")
- **perDay**: `string` - How many times per day (e.g., "2 times", "1 time")
- **dosage**: `string` - Dosage amount (e.g., "100mg", "1000IU", "5ml")
- **stock**: `number` - Current stock count (e.g., 30, 90)
- **frequency**: `string` - Frequency type (e.g., "daily", "weekly", "as needed")
- **times**: `array` - Array of time strings (e.g., ["08:00", "20:00"])
- **daysOfWeek**: `array` - Array of day numbers (0=Sunday, 1=Monday, etc.)
- **startDate**: `string` - When medication starts (YYYY-MM-DD format)
- **endDate**: `string` - When medication ends (YYYY-MM-DD format, empty if ongoing)
- **notes**: `string` - Additional notes about the medication
- **color**: `string` - Hex color code for UI display

### 3. History Data (`users/{userId}/data/history`)
```json
{
  "history": [
    {
      "name": "Old Medication",
      "perWeek": "7 days",
      "perDay": "1 time",
      "dosage": "50mg",
      "stock": 0,
      "frequency": "daily",
      "times": ["10:00"],
      "daysOfWeek": [1, 2, 3, 4, 5, 6, 0],
      "startDate": "2025-09-01",
      "endDate": "2025-10-01",
      "notes": "Discontinued due to side effects",
      "color": "#FFB347",
      "deletedAt": "2025-10-11T12:34:56.789Z",
      "deletedReason": "No longer needed"
    }
  ],
  "updatedAt": "2025-10-11T12:34:56.789Z"
}
```

#### History Object Fields:
- **name**: `string` - Medication name (same as medications)
- **perWeek**: `string` - How many times per week
- **perDay**: `string` - How many times per day
- **dosage**: `string` - Dosage amount
- **stock**: `number` - Stock count when deleted (usually 0)
- **frequency**: `string` - Frequency type
- **times**: `array` - Array of time strings
- **daysOfWeek**: `array` - Array of day numbers
- **startDate**: `string` - When medication originally started
- **endDate**: `string` - When medication was supposed to end
- **notes**: `string` - Notes about the medication
- **color**: `string` - Hex color code for UI display
- **deletedAt**: `string` - When it was deleted (ISO timestamp)
- **deletedReason**: `string` - Why it was deleted (optional)

### 4. Notes Data (`users/{userId}/data/notes`)
```json
{
  "notes": {
    "note_2025-10-11": "Took morning medications at 8:15 AM. Feeling good today.",
    "note_2025-10-10": "Missed evening dose - was out late.",
    "note_2025-10-09": "All medications taken on schedule."
  },
  "updatedAt": "2025-10-11T12:34:56.789Z"
}
```

#### Notes Object Fields:
- **notes**: `object` - Key-value pairs where:
  - **Key**: `string` - Format: `note_YYYY-MM-DD` (e.g., "note_2025-10-11")
  - **Value**: `string` - The actual note text
- **updatedAt**: `string` - Last time notes were updated (ISO timestamp)

#### Note Key Format:
- **Pattern**: `note_{date}`
- **Date Format**: `YYYY-MM-DD`
- **Examples**:
  - `note_2025-10-11` - Note for October 11, 2025
  - `note_2025-12-25` - Note for December 25, 2025
  - `note_2026-01-01` - Note for January 1, 2026

---

## 🔄 Data Flow

### **Registration** (`register.html`)
1. Create Firebase Auth user
2. Save profile to `users/{userId}` (without password)
3. Save to localStorage for offline access

### **Login** (`login.html`)
1. Authenticate with Firebase Auth
2. Load profile from `users/{userId}`
3. Store in localStorage

### **Home** (`home.html`)
**Save:**
- When deleting a medication → Save to both `medications` and `history` documents
- When updating stock → Save to `medications` document

**Load:**
- On page load → Load from `users/{userId}/data/medications`
- Load from `users/{userId}/data/history`

### **History** (`history.html`)
**Load:**
- On page load → Load from `users/{userId}/data/history`

**Save:**
- When permanently deleting → Save updated history to Firestore

### **Calendar** (`calendar.html`)
**Load:**
- On page load → Load from `users/{userId}/data/medications`
- Display medications on calendar based on frequency and times

### **Notes** (`notes.html`)
**Save:**
- Auto-save (debounced 1 second) → Save to `users/{userId}/data/notes`

**Load:**
- On page load → Load from `users/{userId}/data/notes`
- Populate localStorage with note data

### **Profile** (`profile.html`)
**Save:**
- When clicking "Save Changes" → Update `users/{userId}`

**Load:**
- On page load → Load from `users/{userId}`

---

## 🛠️ Implementation Status

### ✅ Completed
1. **Profile Storage** - `users/{userId}` ✓
2. **Medications Storage** - `users/{userId}/data/medications` ✓
3. **History Storage** - `users/{userId}/data/history` ✓
4. **Notes Storage** - `users/{userId}/data/notes` ✓

### ✅ Save Functions
- `saveMedicationsToFirestore()` in `home.html` ✓
- `saveHistoryToFirestore()` in `home.html` ✓
- `saveNotesToFirestore()` in `notes.html` ✓
- Profile save in `profile.html` ✓

### ✅ Load Functions
- Load medications on user change (`onAuthStateChanged`) ✓
- Load history on user change ✓
- Load notes on user change ✓
- Load profile on login ✓

---

## 📝 Notes

1. **Password Security**: Passwords are NEVER stored in Firestore - only in Firebase Auth
2. **Timestamps**: All data documents include an `updatedAt` timestamp
3. **Merge Strategy**: Using `setDoc(..., { merge: true })` to avoid overwriting existing data
4. **Offline Support**: Data is synced to localStorage for offline access
5. **Real-time Updates**: User switching automatically loads correct data from Firestore

---

## 🔐 Security Rules (Recommended)

Add these rules in Firebase Console → Firestore Database → Rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      // Allow access to user's data subcollection
      match /data/{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

These rules ensure:
- Users must be authenticated
- Users can only access their own data
- No user can read or modify another user's data

