# SalesBuster AI — Mobile Application REST API Documentation

This document provides ready-to-use **cURL commands**, request payloads, query parameters, headers, and realistic JSON responses for all API endpoints used by the **SalesBuster Mobile Application** (iOS & Android).

---

## 📌 Mobile App API Configuration

In your mobile app (React Native, Flutter, Swift, Kotlin, etc.), map your endpoint constants to the backend:

```javascript
// Base URL configuration:
// - Production: "https://betaapi.salesbuster.ai/api"
// - Local Dev (Android Emulator): "http://10.0.2.2:5000/api"
// - Local Dev (iOS Simulator / LAN): "http://<YOUR_LOCAL_IP>:5000/api"
export const BASE_URL = "https://betaapi.salesbuster.ai/api";
export const SOCKET_URL = "https://betaapi.salesbuster.ai";

export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: `${BASE_URL}/auth/login`,
  },
  LEADS: {
    BASE: `${BASE_URL}/leads`,
    PAGINATED: `${BASE_URL}/leads/paginated`,
    MISSED_CALL: `${BASE_URL}/leads/missed-call`,
    INBOUND_CALL: `${BASE_URL}/leads/inbound-call`,
    RECORDINGS: (leadId) => `${BASE_URL}/leads/${leadId}/recordings`,
    ANALYZE_RECORDING: (leadId, recordingId) =>
      `${BASE_URL}/leads/${leadId}/analyze-recording/${recordingId}`,
  },
  USERS: {
    BASE: `${BASE_URL}/users`,
  },
  FOLLOWUPS: {
    BASE: `${BASE_URL}/followups`,
  },
  ANALYTICS: {
    LOG_CALL: `${BASE_URL}/analytics/log-call`,
    REP_HISTORY: (salespersonId) => `${BASE_URL}/analytics/${salespersonId}`,
    TODAY: `${BASE_URL}/analytics/today`,
  },
  WHATSAPP: {
    SEND_MESSAGE: `${BASE_URL}/whatsapp/message/send`,
    CONVERSATIONS: `${BASE_URL}/whatsapp/conversations`,
    CHAT_HISTORY: (leadId) => `${BASE_URL}/whatsapp/conversation/${leadId}`,
    SUMMARIZE: (leadId) => `${BASE_URL}/whatsapp/conversation/${leadId}/summarize`,
  },
  ORGANIZATION: {
    SERVICES: `${BASE_URL}/organization/services`,
    SETTINGS: `${BASE_URL}/organization/settings`,
    MY_ORG: `${BASE_URL}/organizations/my-org`,
    QUOTA_SPLIT: `${BASE_URL}/organizations/my-org/quota-split`,
  },
  BI_ANALYST: {
    CHAT: `${BASE_URL}/ai-assistant/chat`,
    SESSIONS: `${BASE_URL}/ai-assistant/sessions`,
    SESSION_BY_ID: (chatId) => `${BASE_URL}/ai-assistant/sessions/${chatId}`,
  },
  APK: {
    LATEST: `${BASE_URL}/mobile-app/apk/latest`,
    DOWNLOAD: `${BASE_URL}/mobile-app/apk/download`,
  },
};
```

---

## 🔑 Authentication & Tenant Isolation

- **Bearer JWT Token**: Every endpoint except `AUTH.LOGIN` and public APK endpoints requires the `Authorization: Bearer <TOKEN>` header.
- **Multi-Tenancy**: The JWT token encodes `tenantDbName` and `organizationId`. The backend automatically isolates all queries to the representative's organization workspace.
- **Modular Add-ons**: Add-on capabilities (`whatsappCampaigns`, `biAnalyst`) are verified dynamically on both JWT authentication and endpoint guards (`requireAddon`).
- **Token Storage**: Store the returned `token`, `_id`, and `role` securely in the mobile client (`EncryptedSharedPreferences`, `Keychain`, or `AsyncStorage`).

---

## 1. Authentication (`AUTH.LOGIN`)

### `POST /auth/login`

Authenticates the user (Sales Representative or Sales Manager), verifies organization subscription validity, and returns an access token with user details, seat metrics, active add-ons, and daily AI conversation quota counters.

#### Headers:

```http
Content-Type: application/json
```

#### Request Body:

```json
{
  "email": "salesrep@acmetech.io",
  "password": "Password123"
}
```

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "salesrep@acmetech.io",
    "password": "Password123"
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "_id": "66dd0a1b2c3d4e5f6a7b8c90",
  "name": "John Doe",
  "email": "salesrep@acmetech.io",
  "phone": "+91 98765 43210",
  "role": "sales person",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2ZGQwYTFiMmMzZDRlNWY2YTdiOGM5MCIsImVtYWlsIjoic2FsZXNyZXBAY21ldGVjaC5pbyIsInJvbGUiOiJzYWxlcyBwZXJzb24iLCJ0ZW5hbnREYk5hbWUiOiJzYl90ZW5hbnRfYWNtZV82NmRkMGEiLCJvcmdhbml6YXRpb25JZCI6IjY2ZGQwYTFhMmMzZDRlNWY2YTdiOGM4ZiIsImlzT3JnT3duZXIiOmZhbHNlLCJpYXQiOjE3MjU3MDg0MDAsImV4cCI6MTcyODMwMDQwMH0.signature",
  "tenantDbName": "sb_tenant_acme_66dd0a",
  "organization": {
    "id": "66dd0a1a2c3d4e5f6a7b8c8f",
    "name": "Acme Technologies Inc.",
    "email": "admin@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "amountPaid": 5990,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-01T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-01T23:59:59.999Z",
    "status": "active",
    "whatsappLineLimit": 2,
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    },
    "dailyAiUsage": {
      "date": "2026-10-16",
      "totalApiCalls": 65,
      "dailyQuotaLimit": 500,
      "whatsappAiCalls": 42,
      "callsApiCalls": 15,
      "biAnalystCalls": 8,
      "quotaSplit": {
        "whatsappAi": 250,
        "calls": 150,
        "biAnalyst": 100
      }
    },
    "isExpired": false,
    "isOrgOwner": false
  }
}
```

#### Error Responses (Organization Status & Credentials):

##### Case 1: Organization Workspace Suspended (`403 Forbidden`)

```json
{
  "success": false,
  "accountSuspended": true,
  "organizationStatus": "suspended",
  "message": "Your organization workspace (Acme Technologies Inc.) is suspended. Please contact administrator."
}
```

##### Case 2: Organization Workspace Inactive (`403 Forbidden`)

```json
{
  "success": false,
  "accountSuspended": true,
  "organizationStatus": "inactive",
  "message": "Your organization workspace (Acme Technologies Inc.) is inactive. Please contact administrator."
}
```

##### Case 3: Organization Subscription Expired (`403 Forbidden`)

```json
{
  "success": false,
  "subscriptionExpired": true,
  "message": "Your organization's subscription (Acme Technologies Inc.) expired on 01 Dec 2026. Please contact administrator to renew."
}
```

##### Case 4: Invalid Credentials (`400 Bad Request`)

```json
{
  "success": false,
  "message": "Invalid credentials"
}
```

---

## 2. Leads Management (`LEADS.BASE`)

### 2.1 Get Paginated Leads (Recommended for Mobile Lists)

### `GET /leads/paginated`

Fetches a paginated list of leads with search, service filter, sales representative filter, status filter, and tab counters.

#### Query Parameters:

| Parameter | Type | Required | Description | Example |
|---|---|---|---|---|
| `page` | Integer | No (Default: 0) | 0-indexed page number | `0` |
| `limit` | Integer or "All" | No (Default: 10) | Items per page | `15` |
| `search` | String | No | Search across name, phone, email, service, city | `Rahul` |
| `service` | String | No (Default: "All") | Filter by specific service | `Product Installation` |
| `salespersonId` | String | No | Filter by Sales Rep ObjectId | `66dd0a1b2c3d4e5f6a7b8c90` |
| `status` | String | No (Default: "All") | Filter by lead status | `Follow Up` |
| `leadTypeTab` | String | No (Default: "New") | Tab: `New`, `TodayFollowup`, `UpcomingFollowup`, `Converted`, `NotAttended`, `Lost`, `OldLeads` | `TodayFollowup` |

#### cURL Request:

```bash
curl -X GET "https://betaapi.salesbuster.ai/api/leads/paginated?page=0&limit=10&leadTypeTab=New" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "leads": [
    {
      "_id": "66e10f443b782910c01a2b3c",
      "name": "Vikram Mehta",
      "phone": "+91 98200 12345",
      "email": "vikram@example.com",
      "service": "Product Installation",
      "status": "New",
      "city": "Mumbai",
      "source": "Website",
      "priority": "High",
      "assignedTo": "66dd0a1b2c3d4e5f6a7b8c90",
      "notes": "Looking for installation next Monday.",
      "recordings": [
        {
          "_id": "6701b9a8c7d6e5f4a3b2c1d0",
          "url": "https://betaapi.salesbuster.ai/uploads/1726501234567-call.mp3",
          "name": "Sales_Discovery_Call.mp3",
          "analysisStatus": "completed",
          "transcription": "Agent: Hello Vikram, calling from Acme. Customer: Yes, I am interested in cloud CRM.",
          "analysis": {
            "summary": "Customer expressed strong interest in cloud CRM migration for 15 users.",
            "sentiment": "Positive",
            "intent": "Purchase",
            "actionItems": ["Send quotation by Wednesday", "Schedule technical demo"]
          },
          "uploadedAt": "2026-10-16T10:30:00.000Z"
        }
      ],
      "createdAt": "2026-10-16T10:00:00.000Z",
      "updatedAt": "2026-10-16T10:32:00.000Z"
    }
  ],
  "totalCount": 42,
  "totalPages": 5,
  "currentPage": 0,
  "tabCounts": {
    "OldLeads": 12,
    "New": 8,
    "TodayFollowup": 5,
    "UpcomingFollowup": 10,
    "Converted": 4,
    "NotAttended": 2,
    "Lost": 1
  }
}
```

---

### 2.2 Create New Lead

### `POST /leads`

Creates a new lead. Supports both **JSON** and **`multipart/form-data`** (when uploading initial audio recordings).

#### Option A: JSON Body (Standard Entry)

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "name": "Ananya Sharma",
    "phone": "+91 98111 22334",
    "email": "ananya.sharma@example.com",
    "service": "Consultation",
    "city": "Bengaluru",
    "source": "Mobile App",
    "status": "New",
    "notes": "Requested a product demo over the weekend."
  }'
```

#### Option B: Multipart / Form-Data (With Call Recording)

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -F "name=Ananya Sharma" \
  -F "phone=+91 98111 22334" \
  -F "email=ananya.sharma@example.com" \
  -F "service=Consultation" \
  -F "city=Bengaluru" \
  -F "recording=@/path/to/call_recording.mp3;type=audio/mpeg" \
  -F "recordingName=Initial_Client_Call.mp3"
```

#### Success Response (`201 Created`):

```json
{
  "success": true,
  "data": {
    "_id": "66e118993b782910c01a2b45",
    "name": "Ananya Sharma",
    "phone": "+91 98111 22334",
    "email": "ananya.sharma@example.com",
    "service": "Consultation",
    "city": "Bengaluru",
    "source": "Mobile App",
    "status": "New",
    "assignedTo": "66dd0a1b2c3d4e5f6a7b8c90",
    "recordings": [],
    "createdAt": "2026-10-16T11:00:00.000Z",
    "updatedAt": "2026-10-16T11:00:00.000Z"
  }
}
```

---

### 2.3 Handle Missed Call Event (`POST /leads/missed-call`)

Called by Android mobile background service when an incoming call is missed. Automatically finds or creates the lead, schedules a follow-up in "Today's Follow-up", and triggers an automated WhatsApp notification.

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads/missed-call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "phone": "+91 98200 55667",
    "callerName": "Sunil Verma"
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Missed call registered. Followup created and automated WhatsApp notification sent.",
  "data": {
    "lead": {
      "_id": "6701c1a2b3c4d5e6f7a8b9c0",
      "name": "Sunil Verma",
      "phone": "+91 98200 55667",
      "status": "Follow Up",
      "source": "Missed Call"
    },
    "followup": {
      "_id": "6701c1a2b3c4d5e6f7a8b9c1",
      "date": "2026-10-16",
      "time": "11:45",
      "notes": "Automated missed call follow-up"
    }
  }
}
```

---

### 2.4 Handle Inbound Call Event (`POST /leads/inbound-call`)

Called when an incoming phone call is answered on the representative's mobile device. Finds existing lead or creates a new one and re-assigns ownership to the answering representative.

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads/inbound-call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "phone": "+91 98200 55667",
    "callerName": "Sunil Verma"
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Inbound call resolved. Lead assigned to representative.",
  "data": {
    "_id": "6701c1a2b3c4d5e6f7a8b9c0",
    "name": "Sunil Verma",
    "phone": "+91 98200 55667",
    "assignedTo": "66dd0a1b2c3d4e5f6a7b8c90",
    "source": "Inbound Call"
  }
}
```

---

### 2.5 Attach Call Audio Recording (`POST /leads/:id/recordings`)

Uploads an audio file (`.mp3`, `.wav`, `.m4a`, `.aac`, `.opus` up to 25 MB) to a lead's record and automatically starts AI background transcription and sentiment analysis.

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads/66e10f443b782910c01a2b3c/recordings \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -F "recording=@/path/to/Call_20261016.mp3" \
  -F "recordingName=Call_20261016.mp3"
```

#### Success Response (`201 Created`):

```json
{
  "success": true,
  "message": "Recording uploaded successfully. AI transcription and analysis started in background.",
  "data": {
    "_id": "6701d4a5b6c7d8e9f0a1b2c3",
    "url": "https://betaapi.salesbuster.ai/uploads/1726504567890-Call_20261016.mp3",
    "name": "Call_20261016.mp3",
    "analysisStatus": "processing",
    "uploadedAt": "2026-10-16T11:50:00.000Z"
  }
}
```

---

### 2.6 Trigger / Retry Audio Analysis (`POST /leads/:id/analyze-recording/:recordingId`)

Triggers or retries AI audio transcription, conversation summarization, and sentiment extraction. **Atomically reserves 1 conversation unit from the Calls channel quota.**

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/leads/66e10f443b782910c01a2b3c/analyze-recording/6701d4a5b6c7d8e9f0a1b2c3 \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "AI audio analysis triggered successfully.",
  "data": {
    "recordingId": "6701d4a5b6c7d8e9f0a1b2c3",
    "analysisStatus": "processing"
  }
}
```

*(Upon completion, the backend broadcasts a `recording_analyzed` Socket.IO event with transcription and analysis).*

---

### 2.7 Update Lead (`PUT /leads/:id`)

Updates lead fields, status, notes, or next follow-up dates.

#### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/leads/66e118993b782910c01a2b45 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "status": "Follow Up",
    "nextFollowUp": "2026-10-20",
    "notes": "Client requested quotation via WhatsApp."
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "_id": "66e118993b782910c01a2b45",
    "name": "Ananya Sharma",
    "status": "Follow Up",
    "nextFollowUp": "2026-10-20",
    "notes": "Client requested quotation via WhatsApp.",
    "updatedAt": "2026-10-16T12:00:00.000Z"
  }
}
```

---

### 2.8 Delete Lead (`DELETE /leads/:id`)

```bash
curl -X DELETE https://betaapi.salesbuster.ai/api/leads/66e118993b782910c01a2b45 \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Lead deleted successfully"
}
```

---

## 3. Team & Users Management (`USERS.BASE`)

### 3.1 Get All Team Members & Seat Usage (`GET /users`)

```bash
curl -X GET https://betaapi.salesbuster.ai/api/users \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "_id": "66dd0a1b2c3d4e5f6a7b8c90",
      "name": "John Doe",
      "email": "salesrep@acmetech.io",
      "phone": "+91 98765 43210",
      "role": "sales person",
      "status": "active"
    }
  ],
  "seats": {
    "totalSeats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "isLimitReached": false
  }
}
```

---

### 3.2 Add a New Sales Representative (`POST /users`)

```bash
curl -X POST https://betaapi.salesbuster.ai/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "name": "Karan Patel",
    "email": "karan.patel@acmetech.io",
    "phone": "+91 98989 12345",
    "password": "SecurePassword123"
  }'
```

#### Success Response (`201 Created`):

```json
{
  "success": true,
  "message": "Sales representative created successfully and login credentials sent via email.",
  "data": {
    "_id": "66dd0c3d4e5f6a7b8c92",
    "name": "Karan Patel",
    "email": "karan.patel@acmetech.io",
    "phone": "+91 98989 12345",
    "role": "sales person"
  },
  "seats": {
    "totalSeats": 10,
    "usedSeats": 5,
    "remainingSeats": 5
  }
}
```

---

## 4. Follow-ups Management (`FOLLOWUPS.BASE`)

### 4.1 Get All Follow-ups (`GET /followups`)

```bash
curl -X GET https://betaapi.salesbuster.ai/api/followups \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "_id": "66e12a013b782910c01a2b60",
      "leadId": "66e10f443b782910c01a2b3c",
      "leadName": "Vikram Mehta",
      "type": "Call",
      "date": "2026-10-17",
      "time": "14:30",
      "priority": "High",
      "notes": "Discuss technical specifications and quote pricing.",
      "done": false
    }
  ]
}
```

---

### 4.2 Schedule a Follow-up (`POST /followups`)

```bash
curl -X POST https://betaapi.salesbuster.ai/api/followups \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "leadId": "66e10f443b782910c01a2b3c",
    "leadName": "Vikram Mehta",
    "type": "Call",
    "date": "2026-10-17",
    "time": "14:30",
    "priority": "High",
    "notes": "Discuss technical specifications and quote pricing."
  }'
```

#### Success Response (`201 Created`):

```json
{
  "success": true,
  "data": {
    "_id": "66e12a013b782910c01a2b60",
    "leadId": "66e10f443b782910c01a2b3c",
    "leadName": "Vikram Mehta",
    "type": "Call",
    "date": "2026-10-17",
    "time": "14:30",
    "priority": "High",
    "done": false
  }
}
```

---

### 4.3 Update Follow-up Done Status (`PUT /followups/:id`)

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/followups/66e12a013b782910c01a2b60 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "done": true
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "_id": "66e12a013b782910c01a2b60",
    "done": true
  }
}
```

---

## 5. Telecaller Analytics & Call Logging (`ANALYTICS.LOG_CALL`)

### 5.1 Log a Phone Call (`POST /analytics/log-call`)

Called automatically by the mobile app when an outbound or inbound call terminates.

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/analytics/log-call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "salespersonId": "66dd0a1b2c3d4e5f6a7b8c90",
    "salesperson": "John Doe",
    "date": "2026-10-16",
    "duration": 185,
    "callType": "outgoing",
    "status": "connected"
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "_id": "66e13b443b782910c01a2b75",
    "salespersonId": "66dd0a1b2c3d4e5f6a7b8c90",
    "salesperson": "John Doe",
    "date": "2026-10-16",
    "totalCalls": 18,
    "talkTime": 2450,
    "longestCall": 380,
    "incoming": 5,
    "outgoing": 13,
    "connected": 14,
    "missed": 2,
    "rejected": 1,
    "notConnected": 1
  }
}
```

---

### 5.2 Get Rep 7-Day Performance History (`GET /analytics/:salespersonId`)

```bash
curl -X GET https://betaapi.salesbuster.ai/api/analytics/66dd0a1b2c3d4e5f6a7b8c90 \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "_id": "66e13b443b782910c01a2b75",
      "date": "2026-10-16",
      "totalCalls": 18,
      "talkTime": 2450,
      "longestCall": 380,
      "connected": 14,
      "missed": 2
    }
  ]
}
```

---

## 6. WhatsApp Messaging for Mobile Representatives

### 6.1 Send WhatsApp Message to Lead (`POST /whatsapp/message/send`)

Allows sales representatives to send direct messages from their assigned lead view.

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/whatsapp/message/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "leadId": "66e10f443b782910c01a2b3c",
    "message": "Hello Vikram, following up on our call regarding the Cloud CRM proposal."
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Message dispatched successfully via WhatsApp.",
  "data": {
    "messageId": "wamid.HBgMOTE...",
    "leadId": "66e10f443b782910c01a2b3c",
    "status": "sent",
    "timestamp": "2026-10-16T12:15:00.000Z"
  }
}
```

---

### 6.2 Get Lead WhatsApp Conversation History (`GET /whatsapp/conversation/:leadId`)

Fetches all inbound and outbound WhatsApp chat messages with message delivery statuses (`sent`, `delivered`, `read`).

#### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/whatsapp/conversation/66e10f443b782910c01a2b3c \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "_id": "6701f2a3b4c5d6e7f8a9b0c1",
      "sender": "lead",
      "text": "Hi, could you send the pricing for 10 users?",
      "timestamp": "2026-10-16T10:15:00.000Z"
    },
    {
      "_id": "6701f2a3b4c5d6e7f8a9b0c2",
      "sender": "agent",
      "text": "Sure Vikram! Our quarterly plan for 10 seats is 5,990 INR.",
      "status": "read",
      "timestamp": "2026-10-16T10:18:00.000Z"
    }
  ]
}
```

---

## 7. Organization Catalog, Profile & Quota Split

### 7.1 Get Organization Services Catalog (`GET /organization/services`)

Used to populate service dropdown menus in lead creation and filtering screens.

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organization/services \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "name": "General Enquiry",
      "description": "General consultation regarding products and services."
    },
    {
      "name": "Cloud CRM Migration",
      "description": "Enterprise cloud database setup and user onboarding."
    }
  ]
}
```

---

### 7.2 Get Organization Profile & Daily Quota Status (`GET /organizations/my-org`)

Returns organization settings, active add-ons, and real-time usage metrics across all 3 AI channels.

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organizations/my-org \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "id": "66dd0a1a2c3d4e5f6a7b8c8f",
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "seats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "subscriptionPlan": "quarterly",
    "subscriptionEndDate": "2026-12-01T23:59:59.999Z",
    "whatsappLineLimit": 2,
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    },
    "dailyAiUsage": {
      "date": "2026-10-16",
      "whatsappAiCalls": 42,
      "callsApiCalls": 15,
      "biAnalystCalls": 8,
      "totalApiCalls": 65,
      "dailyQuotaLimit": 500,
      "quotaSplit": {
        "whatsappAi": 250,
        "calls": 150,
        "biAnalyst": 100
      }
    },
    "totalLeads": 142,
    "totalFollowups": 38,
    "isExpired": false
  }
}
```

---

### 7.3 Split Daily 500 Conversation Quota (`PUT /organizations/my-org/quota-split`)

Allows Sales Managers and Owners to partition their organization's fixed daily quota of **500 conversations** across WhatsApp, Calls, and BI Analyst.

#### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/my-org/quota-split \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "whatsappAi": 250,
    "calls": 150,
    "biAnalyst": 100
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Daily conversation quota split updated successfully.",
  "data": {
    "quotaSplit": {
      "whatsappAi": 250,
      "calls": 150,
      "biAnalyst": 100
    },
    "dailyQuotaLimit": 500,
    "totalAllocated": 500,
    "unallocated": 0,
    "usage": {
      "whatsappAiCalls": 42,
      "callsApiCalls": 15,
      "biAnalystCalls": 8,
      "totalApiCalls": 65
    }
  }
}
```

---

## 8. BI Analyst AI Assistant (Chat & Voice)

> [!IMPORTANT]
> - **Access Level**: Restricted strictly to **Sales Managers**, **Organization Owners**, and **Super Admins**.
> - **Add-on Required**: The organization must have `addons.biAnalyst: true`.
> - **Quota Enforcement**: Every text query or Gemini Live voice turn atomically reserves **1 unit** from the organization's `biAnalyst` daily quota.

---

### 8.1 Ask CRM Assistant Question (`POST /ai-assistant/chat`)

Processes conversational questions against live tenant CRM records (e.g. leads, conversion metrics, salesperson leaderboard, follow-ups).

#### Request Body:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | String | **Yes** | Natural language CRM question |
| `chatId` | String | No | Existing chat session ObjectId (creates new if omitted) |

#### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/ai-assistant/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_MANAGER_JWT_TOKEN>" \
  -d '{
    "message": "Who are our top 3 performing sales representatives this month?",
    "chatId": "6702a1b2c3d4e5f6a7b8c901"
  }'
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "chatId": "6702a1b2c3d4e5f6a7b8c901",
  "reply": "Here are the top performing sales representatives for this month:\n\n1. **John Doe**: 18 leads handled, 7 won deals, 38.8% conversion rate.\n2. **Sara Khan**: 15 leads handled, 5 won deals, 33.3% conversion rate.\n3. **Karan Patel**: 12 leads handled, 3 won deals, 25.0% conversion rate.",
  "options": [
    "View John Doe's active leads",
    "Show conversion rates by lead source",
    "Inspect pending follow-ups"
  ],
  "toolsUsed": [
    "get_salesperson_performance"
  ],
  "modelUsed": "gemini-2.5-flash",
  "executionTimeMs": 1340,
  "updatedAt": "2026-10-16T12:30:00.000Z"
}
```

#### Error Response: Add-on Inactive (`403 Forbidden`):

```json
{
  "success": false,
  "message": "This feature requires the biAnalyst add-on. Please upgrade your organization plan to access this feature.",
  "addonRequired": "biAnalyst"
}
```

#### Error Response: Quota Exhausted (`429 Too Many Requests`):

```json
{
  "success": false,
  "message": "Daily quota limit for BI Analyst reached (100/100). Resets at 00:00 UTC.",
  "quotaExceeded": true,
  "channel": "biAnalyst",
  "used": 100,
  "limit": 100
}
```

---

### 8.2 Get Assistant Chat Sessions (`GET /ai-assistant/sessions`)

Fetches all conversation sessions with smart titles and message counts for the sidebar drawer:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/ai-assistant/sessions \
  -H "Authorization: Bearer <YOUR_MANAGER_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": [
    {
      "_id": "6702a1b2c3d4e5f6a7b8c901",
      "title": "Top performing sales reps this month",
      "messageCount": 4,
      "lastMessageSnippet": "Here are the top performing sales representatives for this month",
      "updatedAt": "2026-10-16T12:30:00.000Z",
      "createdAt": "2026-10-16T12:20:00.000Z"
    }
  ]
}
```

---

### 8.3 Get Full Chat Session Thread (`GET /ai-assistant/sessions/:chatId`)

```bash
curl -X GET https://betaapi.salesbuster.ai/api/ai-assistant/sessions/6702a1b2c3d4e5f6a7b8c901 \
  -H "Authorization: Bearer <YOUR_MANAGER_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "_id": "6702a1b2c3d4e5f6a7b8c901",
    "title": "Top performing sales reps this month",
    "messages": [
      {
        "role": "user",
        "content": "Who are our top 3 performing sales representatives this month?",
        "timestamp": "2026-10-16T12:20:00.000Z"
      },
      {
        "role": "assistant",
        "content": "Here are the top performing sales representatives for this month...",
        "options": ["View John Doe's active leads"],
        "toolsUsed": ["get_salesperson_performance"],
        "timestamp": "2026-10-16T12:20:01.340Z"
      }
    ]
  }
}
```

---

### 8.4 Delete Chat Session (`DELETE /ai-assistant/sessions/:chatId`)

```bash
curl -X DELETE https://betaapi.salesbuster.ai/api/ai-assistant/sessions/6702a1b2c3d4e5f6a7b8c901 \
  -H "Authorization: Bearer <YOUR_MANAGER_JWT_TOKEN>"
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Chat session deleted successfully."
}
```

---

### 8.5 Gemini Live Real-Time Bidirectional Voice Assistant over Socket.IO

Enables interactive speech-to-speech conversations with native CRM database tool execution.

#### Connecting Socket.IO in Mobile (React Native / Flutter / Native):

```javascript
import { io } from "socket.io-client";

const socket = io("https://betaapi.salesbuster.ai", {
  auth: {
    token: userJwtToken, // Sales Manager JWT
  },
  transports: ["websocket"],
});
```

#### Socket.IO Event Reference:

| Event Name | Direction | Payload Example | Description |
|---|---|---|---|
| `bi_voice_start` | Mobile &rarr; Server | `{ voiceName: "Aoede" }` | Starts session. Voices: `Aoede`, `Charon`, `Kore`, `Fenrir`, `Puck`. |
| `bi_voice_audio_in` | Mobile &rarr; Server | `"base64PCM16kHzString..."` | Sends PCM 16kHz audio chunk from user microphone. |
| `bi_voice_audio_out` | Server &rarr; Mobile | `{ mimeType: "audio/pcm;rate=24000", data: "base64..." }` | Receives PCM 24kHz audio chunk for native speaker playback. |
| `bi_voice_transcript`| Server &rarr; Mobile | `{ role: "assistant", text: "Here are..." }` | Live subtitle text stream. |
| `bi_voice_status` | Server &rarr; Mobile | `{ state: "connected" \| "tool_running" \| "speaking" \| "closed", toolName? }` | Real-time state indicators for UI badge. |
| `bi_voice_turn_complete` | Server &rarr; Mobile | `{}` | Emitted when assistant finishes current turn. |
| `bi_voice_interrupted` | Server &rarr; Mobile | `{}` | Emitted when user speaks mid-assistant audio (barge-in). |
| `bi_voice_stop` | Mobile &rarr; Server | `{}` | Ends voice session. |
| `bi_voice_error` | Server &rarr; Mobile | `{ message, quotaExceeded?: true }` | Emitted when quota runs out or session fails. |

---

## 9. Mobile App APK Updates & Direct Download

### 9.1 Check Latest APK Version (`GET /mobile-app/apk/latest`)

```bash
curl -X GET https://betaapi.salesbuster.ai/api/mobile-app/apk/latest
```

#### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "version": "1.0.4",
    "versionCode": 4,
    "minSupportedVersion": "1.0.0",
    "releaseNotes": "Added background call recording, real-time lead sync, and quota split monitor.",
    "fileSizeFormatted": "43.12 MB",
    "downloadUrl": "https://betaapi.salesbuster.ai/api/mobile-app/apk/download"
  }
}
```

---

### 9.2 Direct APK Download (`GET /mobile-app/apk/download`)

```bash
curl -O -J https://betaapi.salesbuster.ai/api/mobile-app/apk/download
```

---

## 10. Common Error Codes & Mobile Interceptor Reference

| Status Code | Reason | Flags in Body | Recommended Mobile Action |
|---|---|---|---|
| `400 Bad Request` | Missing field or invalid input | `success: false` | Display toast or form alert message. |
| `401 Unauthorized` | Token expired or invalid | `success: false` | Clear stored credentials and navigate to Login. |
| `403 Forbidden` | Workspace suspended | `accountSuspended: true` | Lock navigation; show "Account Suspended" screen. |
| `403 Forbidden` | Subscription expired | `subscriptionExpired: true` | Lock navigation; show "Subscription Expired" screen. |
| `403 Forbidden` | Feature add-on missing | `addonRequired: "biAnalyst"` | Prompt manager to unlock add-on. |
| `403 Forbidden` | Seat limit reached | `seatLimitReached: true` | Show "Upgrade Plan / Seat Limit Reached" alert. |
| `404 Not Found` | Resource or lead missing | `success: false` | Show not-found banner or refresh list. |
| `429 Too Many Requests` | Daily AI conversation quota full | `quotaExceeded: true` | Show "Daily conversation quota reached (resets 00:00 UTC)". |
| `500 Server Error` | Backend server exception | `success: false` | Show retry snackbar with exponential backoff. |

---

### Mobile App Axios Global Interceptor Example

```javascript
import axios from "axios";
import { navigate } from "./navigationRef";

const apiClient = axios.create({
  baseURL: "https://betaapi.salesbuster.ai/api",
  timeout: 15000,
});

apiClient.interceptors.request.use((config) => {
  const token = getStoredAuthToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const { status, data } = error.response;

      if (status === 403 && data.subscriptionExpired) {
        navigate("SubscriptionExpiredScreen", { message: data.message });
        return Promise.reject(error);
      }

      if (status === 403 && data.accountSuspended) {
        navigate("AccountSuspendedScreen", { message: data.message });
        return Promise.reject(error);
      }

      if (status === 429 && data.quotaExceeded) {
        showToastAlert(`Quota limit reached for ${data.channel}. Resets at 00:00 UTC.`);
        return Promise.reject(error);
      }

      if (status === 401) {
        clearAuthToken();
        navigate("LoginScreen");
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
```
