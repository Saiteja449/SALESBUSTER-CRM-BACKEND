# SalesBuster AI — Mobile Application REST API Documentation

This document provides ready-to-use **cURL commands**, request payloads, query parameters, headers, and realistic JSON responses for all API endpoints used by the **SalesBuster Mobile Application**.

---

## 📌 Mobile App API Configuration

In your mobile app (React Native, Flutter, Swift, Kotlin, etc.), your endpoint constants mapping to the backend:

```javascript
// Base URL configuration:
// - Production: "https://api.salesbuster.ai/api"
// - Local Dev (Android Emulator): "http://10.0.2.2:5000/api"
// - Local Dev (iOS Simulator / LAN): "http://<YOUR_LOCAL_IP>:5000/api"
export const BASE_URL = "https://api.salesbuster.ai/api";

export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: `${BASE_URL}/auth/login`,
  },
  LEADS: {
    BASE: `${BASE_URL}/leads`,
  },
  USERS: {
    BASE: `${BASE_URL}/users`,
  },
  FOLLOWUPS: {
    BASE: `${BASE_URL}/followups`,
  },
  ANALYTICS: {
    LOG_CALL: `${BASE_URL}/analytics/log-call`,
  },
  ORGANIZATION: {
    SERVICES: `${BASE_URL}/organization/services`,
    SETTINGS: `${BASE_URL}/organization/settings`,
  },
};
```

---

## 🔑 Authentication & Tenant Isolation

- **Bearer JWT Token**: Every endpoint except `AUTH.LOGIN` requires the `Authorization: Bearer <TOKEN>` header.
- **Multi-Tenancy**: The JWT token encodes `tenantDbName` and `organizationId`. The backend automatically isolates all queries to the representative's organization workspace.
- **Token Storage**: Store the returned `token`, `_id`, and `role` securely in the mobile client (e.g. `EncryptedSharedPreferences`, `Keychain`, or `AsyncStorage`).

---

## 1. Authentication (`AUTH.LOGIN`)

### `POST /auth/login`
Authenticates the user (Sales Representative or Sales Manager), verifies organization subscription validity, and returns an access token with user details and organization metadata.

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
curl -X POST https://api.salesbuster.ai/api/auth/login \
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
    "isExpired": false,
    "isOrgOwner": false
  }
}
```

#### Error Responses (Organization Status & Credentials):

##### Case 1: Organization Workspace Suspended (`403 Forbidden`)
Occurs when the organization account has been suspended by the Super Administrator:
```json
{
  "success": false,
  "message": "Your organization workspace (Acme Technologies Inc.) is suspended. Please contact administrator."
}
```

##### Case 2: Organization Workspace Inactive (`403 Forbidden`)
Occurs when the organization account has been set to inactive:
```json
{
  "success": false,
  "message": "Your organization workspace (Acme Technologies Inc.) is inactive. Please contact administrator."
}
```

##### Case 3: Organization Subscription Expired (`403 Forbidden`)
Occurs when the subscription validity end date (`subscriptionEndDate`) has passed:
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

##### Case 5: User Account Not Found (`404 Not Found`)
```json
{
  "success": false,
  "message": "User not found"
}
```

---

## 2. Leads Management (`LEADS.BASE`)

### 2.1 Get Paginated Leads (Recommended for Mobile Lists)
### `GET /leads/paginated`
Fetches a paginated list of leads with full-text search, service filter, sales representative filter, status filter, and tab counters (`New`, `TodayFollowup`, `UpcomingFollowup`, `Converted`, `NotAttended`, `Lost`, `OldLeads`).

#### Query Parameters:
| Parameter | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `page` | Integer | No (Default: 0) | 0-indexed page number | `0` |
| `limit` | Integer or "All" | No (Default: 10) | Items per page | `15` |
| `search` | String | No | Search across name, phone, email, service, city | `Rahul` |
| `service` | String | No (Default: "All")| Filter by specific service | `Product Installation` |
| `salespersonId`| String | No | Filter by Sales Rep ObjectId | `66dd0a1b2c3d4e5f6a7b8c90` |
| `status` | String | No (Default: "All")| Filter by lead status | `Follow Up` |
| `leadTypeTab` | String | No (Default: "New")| Tab category: `New`, `TodayFollowup`, `UpcomingFollowup`, `Converted`, `NotAttended`, `Lost`, `OldLeads` | `TodayFollowup` |

#### cURL Request:
```bash
curl -X GET "https://api.salesbuster.ai/api/leads/paginated?page=0&limit=10&leadTypeTab=New" \
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
      "recordings": [],
      "createdAt": "2026-09-08T10:30:00.000Z",
      "updatedAt": "2026-09-08T10:30:00.000Z"
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

### 2.2 Get All Leads (Unpaginated)
### `GET /leads`
Fetches all leads within the tenant database.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/leads \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "_id": "66e10f443b782910c01a2b3c",
      "name": "Vikram Mehta",
      "phone": "+91 98200 12345",
      "email": "vikram@example.com",
      "service": "Product Installation",
      "status": "New",
      "assignedTo": "66dd0a1b2c3d4e5f6a7b8c90",
      "createdAt": "2026-09-08T10:30:00.000Z"
    }
  ]
}
```

---

### 2.3 Create New Lead
### `POST /leads`
Creates a new lead. If `assignedTo` is omitted or `"Unassigned"`, it is automatically assigned to an active Sales Representative via round-robin.

Supports both **JSON** and **`multipart/form-data`** (when uploading call recordings or attachments).

#### Option A: JSON Body (Standard Entry)
```bash
curl -X POST https://api.salesbuster.ai/api/leads \
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

#### Option B: Multipart / Form-Data (With Call Audio Recording)
```bash
curl -X POST https://api.salesbuster.ai/api/leads \
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
    "createdAt": "2026-09-08T11:00:00.000Z",
    "updatedAt": "2026-09-08T11:00:00.000Z"
  }
}
```

---

### 2.4 Update Lead
### `PUT /leads/:id`
Updates lead fields, changes status (e.g. `Follow Up`, `Converted`, `Not Attended`, `Lost`), updates notes, or attaches audio recordings.

#### cURL Request:
```bash
curl -X PUT https://api.salesbuster.ai/api/leads/66e118993b782910c01a2b45 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "status": "Follow Up",
    "nextFollowUp": "2026-09-10",
    "notes": "Client requested proposal quotation via WhatsApp."
  }'
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "data": {
    "_id": "66e118993b782910c01a2b45",
    "name": "Ananya Sharma",
    "phone": "+91 98111 22334",
    "service": "Consultation",
    "status": "Follow Up",
    "nextFollowUp": "2026-09-10",
    "notes": "Client requested proposal quotation via WhatsApp.",
    "updatedAt": "2026-09-08T11:15:00.000Z"
  }
}
```

---

### 2.5 Delete Lead
### `DELETE /leads/:id`

#### cURL Request:
```bash
curl -X DELETE https://api.salesbuster.ai/api/leads/66e118993b782910c01a2b45 \
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

### 3.1 Get All Team Members / Sales Representatives
### `GET /users`
Fetches all sales representatives in the tenant organization, plus current seat capacity and remaining licenses.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/users \
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
    },
    {
      "_id": "66dd0b2c3d4e5f6a7b8c91",
      "name": "Sara Khan",
      "email": "sara.k@acmetech.io",
      "phone": "+91 98765 43211",
      "role": "sales person",
      "status": "active"
    }
  ],
  "seats": {
    "totalSeats": 10,
    "usedSeats": 2,
    "remainingSeats": 8,
    "isLimitReached": false
  },
  "organization": {
    "id": "66dd0a1a2c3d4e5f6a7b8c8f",
    "name": "Acme Technologies Inc.",
    "seats": 10,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-01T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-01T23:59:59.999Z",
    "status": "active"
  }
}
```

---

### 3.2 Add a New Sales Representative
### `POST /users`
Enforces seat limit checks. If `password` is omitted, auto-generates a secure temporary password and emails credentials directly to the representative.

#### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/users \
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
  "emailSent": true,
  "data": {
    "_id": "66dd0c3d4e5f6a7b8c92",
    "name": "Karan Patel",
    "email": "karan.patel@acmetech.io",
    "phone": "+91 98989 12345",
    "role": "sales person"
  },
  "seats": {
    "totalSeats": 10,
    "usedSeats": 3,
    "remainingSeats": 7
  }
}
```

#### Error Response when Seat Limit is Reached (`403 Forbidden`):
```json
{
  "success": false,
  "seatLimitReached": true,
  "message": "Seat limit reached (10/10 seats allocated). Please contact your administrator to upgrade your plan.",
  "totalSeats": 10,
  "usedSeats": 10
}
```

---

### 3.3 Delete Sales Representative
### `DELETE /users/:id`
Deletes a sales representative, reassigns their active leads to `"Unassigned"`, and frees up a subscription license seat.

#### cURL Request:
```bash
curl -X DELETE https://api.salesbuster.ai/api/users/66dd0c3d4e5f6a7b8c92 \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Representative removed successfully. Seat freed up.",
  "seats": {
    "totalSeats": 10,
    "usedSeats": 2,
    "remainingSeats": 8
  }
}
```

---

## 4. Follow-ups Management (`FOLLOWUPS.BASE`)

### 4.1 Get All Follow-ups
### `GET /followups`
Fetches all scheduled follow-ups sorted with newest first.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/followups \
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
      "date": "2026-09-09",
      "time": "14:30",
      "priority": "High",
      "notes": "Discuss technical specifications and quote pricing.",
      "author": "John Doe",
      "done": false,
      "createdAt": "2026-09-08T11:30:00.000Z"
    }
  ]
}
```

---

### 4.2 Create / Schedule a Follow-up
### `POST /followups`

#### Request Body Fields:
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `leadId` | String | Yes | Lead ObjectId |
| `leadName` | String | Yes | Lead full name |
| `type` | String | Yes | E.g. `"Call"`, `"Meeting"`, `"Email"`, `"WhatsApp"` |
| `date` | String | Yes | Date string (`YYYY-MM-DD`) |
| `time` | String | Yes | Time string (`HH:mm`) |
| `priority` | String | No | `"Low"`, `"Medium"`, `"High"` |
| `notes` | String | No | Detailed follow-up instructions |
| `author` | String | No | Representative's name |
| `done` | Boolean | No | Default: `false` |

#### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/followups \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "leadId": "66e10f443b782910c01a2b3c",
    "leadName": "Vikram Mehta",
    "type": "Call",
    "date": "2026-09-09",
    "time": "14:30",
    "priority": "High",
    "notes": "Discuss technical specifications and quote pricing.",
    "author": "John Doe",
    "done": false
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
    "date": "2026-09-09",
    "time": "14:30",
    "priority": "High",
    "notes": "Discuss technical specifications and quote pricing.",
    "author": "John Doe",
    "done": false,
    "createdAt": "2026-09-08T11:30:00.000Z",
    "updatedAt": "2026-09-08T11:30:00.000Z"
  }
}
```

---

### 4.3 Update Follow-up Status
### `PUT /followups/:id`
Marks a follow-up as completed or pending.

#### cURL Request:
```bash
curl -X PUT https://api.salesbuster.ai/api/followups/66e12a013b782910c01a2b60 \
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
    "leadId": "66e10f443b782910c01a2b3c",
    "leadName": "Vikram Mehta",
    "type": "Call",
    "done": true,
    "updatedAt": "2026-09-08T12:00:00.000Z"
  }
}
```

---

## 5. Telecaller Analytics & Call Logging (`ANALYTICS.LOG_CALL`)

### 5.1 Log a Phone Call
### `POST /analytics/log-call`
Called automatically by the mobile app after a phone call completes or ends. Increments total calls, talk time duration, longest call record, and categorized counters (`incoming`, `outgoing`, `connected`, `missed`, `rejected`, `not-connected`).

#### Request Body Fields:
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `salespersonId` | String | Recommended | Sales Rep User ObjectId |
| `salesperson` | String | Optional | Sales Rep Name |
| `date` | String | Yes | Date string (`YYYY-MM-DD`) |
| `duration` | Number | Yes | Call duration in seconds |
| `callType` | String | Yes | `"incoming"` or `"outgoing"` |
| `status` | String | Yes | `"connected"`, `"missed"`, `"rejected"`, or `"not-connected"` |

#### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/analytics/log-call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "salespersonId": "66dd0a1b2c3d4e5f6a7b8c90",
    "salesperson": "John Doe",
    "date": "2026-09-08",
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
    "date": "2026-09-08",
    "totalCalls": 18,
    "talkTime": 2450,
    "longestCall": 380,
    "incoming": 5,
    "outgoing": 13,
    "connected": 14,
    "missed": 2,
    "rejected": 1,
    "notConnected": 1,
    "createdAt": "2026-09-08T09:00:00.000Z",
    "updatedAt": "2026-09-08T12:05:00.000Z"
  }
}
```

---

### 5.2 Get Rep Performance Analytics (Bonus Mobile Report)
### `GET /analytics/:salespersonId`
Fetches the last 7 days of daily call performance records for the representative.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/analytics/66dd0a1b2c3d4e5f6a7b8c90 \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "_id": "66e13b443b782910c01a2b75",
      "date": "2026-09-08",
      "totalCalls": 18,
      "talkTime": 2450,
      "longestCall": 380,
      "incoming": 5,
      "outgoing": 13,
      "connected": 14,
      "missed": 2
    }
  ]
}
```

---

## 6. Organization Services Catalog (`ORGANIZATION.SERVICES`)

### `GET /organization/services`
*(Also accessible at `GET /organizations/services`)*

Returns the catalog of active services and offerings configured for the organization. Mobile apps use this endpoint to dynamically populate dropdown menus when creating/editing leads, filtering lists, or assigning enquiries.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/organization/services \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "name": "General Enquiry",
      "description": "General inquiry or consultation regarding products, services, and customer requirements.",
      "keywords": [
        "enquiry",
        "inquiry",
        "details",
        "information",
        "help"
      ]
    },
    {
      "name": "Product Installation",
      "description": "Full end-to-end on-site hardware and software installation services.",
      "keywords": [
        "installation",
        "setup",
        "configure",
        "deployment"
      ]
    },
    {
      "name": "Annual Maintenance (AMC)",
      "description": "Preventive maintenance, quarterly servicing, and emergency repairs.",
      "keywords": [
        "maintenance",
        "amc",
        "service",
        "repair"
      ]
    }
  ]
}
```

---

## 7. Organization Profile & Settings (`ORGANIZATION.SETTINGS`)

### `GET /organization/settings`
*(Also accessible at `GET /organization/my-org` or `GET /organizations/my-org`)*

Returns organization details, seat capacities, active subscription status, and AI configuration summary.

#### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/organization/settings \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "data": {
    "_id": "66dd0a1a2c3d4e5f6a7b8c8f",
    "name": "Acme Technologies Inc.",
    "email": "admin@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "usedSeats": 3,
    "remainingSeats": 7,
    "amountPaid": 5990,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-01T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-01T23:59:59.999Z",
    "status": "active",
    "isExpired": false,
    "remainingDays": 84,
    "totalLeads": 142,
    "totalFollowups": 38,
    "aiSettings": {
      "companyName": "Acme Technologies Inc.",
      "businessDescription": "Acme Technologies provides enterprise cloud CRM and telecalling automation solutions.",
      "agentPersona": "friendly, human sales representative",
      "services": [
        {
          "name": "General Enquiry",
          "description": "General inquiry or consultation regarding products, services, and customer requirements."
        },
        {
          "name": "Product Installation",
          "description": "Full end-to-end on-site hardware and software installation services."
        }
      ]
    }
  }
}
```

---

## 8. Summary Quick-Reference Table

| Group | Key | HTTP Method | Endpoint Path | Auth Required | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AUTH** | `LOGIN` | `POST` | `/auth/login` | ❌ No | Login with email & password |
| **LEADS** | `BASE` | `GET` | `/leads/paginated` | ✅ Bearer JWT | Paginated leads + tab counters |
| | | `GET` | `/leads` | ✅ Bearer JWT | Fetch all leads |
| | | `POST` | `/leads` | ✅ Bearer JWT | Create lead (JSON or audio) |
| | | `PUT` | `/leads/:id` | ✅ Bearer JWT | Update lead status/details |
| | | `DELETE`| `/leads/:id` | ✅ Bearer JWT | Delete lead |
| **USERS** | `BASE` | `GET` | `/users` | ✅ Bearer JWT | List sales reps & seat usage |
| | | `POST` | `/users` | ✅ Bearer JWT | Add new sales representative |
| | | `DELETE`| `/users/:id` | ✅ Bearer JWT | Delete representative |
| **FOLLOWUPS** | `BASE` | `GET` | `/followups` | ✅ Bearer JWT | List all follow-ups |
| | | `POST` | `/followups` | ✅ Bearer JWT | Schedule a new follow-up |
| | | `PUT` | `/followups/:id` | ✅ Bearer JWT | Mark done / update follow-up |
| **ANALYTICS**| `LOG_CALL` | `POST` | `/analytics/log-call` | ✅ Bearer JWT | Telecaller call log tracker |
| | | `GET` | `/analytics/:salespersonId` | ✅ Bearer JWT | 7-day daily call history |
| **ORGANIZATION**| `SERVICES`| `GET` | `/organization/services` | ✅ Bearer JWT | Catalog of active services |
| | `SETTINGS`| `GET` | `/organization/settings` | ✅ Bearer JWT | Organization profile & settings |

---

## 9. Common Error Codes & Handling in Mobile Apps

| Status Code | Reason | Server Response Flags | Mobile App Recommended Action |
| :--- | :--- | :--- | :--- |
| **`400 Bad Request`** | Validation error or duplicate lead | `success: false` | Display `message` returned in toast or form alert. |
| **`401 Unauthorized`** | Token expired or invalid | `success: false` | Clear token and redirect to Login screen. |
| **`403 Forbidden`** | Organization suspended or inactive | `accountSuspended: true`, `organizationStatus` | Navigate to "Workspace Suspended" screen. |
| **`403 Forbidden`** | Organization subscription expired | `subscriptionExpired: true` | Navigate to "Subscription Expired / Renew" screen. |
| **`403 Forbidden`** | Seat limit reached | `seatLimitReached: true` | Display modal prompting to upgrade license plan. |
| **`404 Not Found`** | Resource or user not found | `success: false` | Show not found banner or refresh list. |
| **`500 Server Error`** | Unhandled internal exception | `success: false` | Show retry snackbar with exponential backoff. |

---

## 10. Organization Status & Subscription Lifecycle Handling

The backend strictly enforces multi-tenant state and billing controls on **both Login and all authenticated API requests** via server-side middlewares (`tenantMiddleware`, `checkSubscriptionActive`, `protect`).

### 10.1 Organization States Summary

| Status | `organization.status` | `isExpired` | Meaning | Mobile App Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Active** | `"active"` | `false` | Workspace in good standing; subscription is valid. | Full access to leads, calls, analytics, and followups. |
| **Suspended** | `"suspended"` | Any | Organization workspace frozen by Super Administrator. | Lock app navigation; show "Account Suspended" screen. |
| **Inactive** | `"inactive"` | Any | Organization workspace deactivated. | Lock app navigation; show "Account Deactivated" screen. |
| **Expired** | `"active"` or Any | `true` | `subscriptionEndDate` has passed. | Lock creation/update; show "Subscription Expired" screen. |

---

### 10.2 Server Response Schemas for Organization Lifecycle Events

All authenticated mobile requests (`/leads`, `/followups`, `/users`, `/analytics`, `/organization/*`) pass through the `checkSubscriptionActive` and `protect` middleware. When an issue occurs, the server responds with **`HTTP 403 Forbidden`** and structured metadata flags:

#### 1. When Organization is Suspended (`403 Forbidden`)
```json
{
  "success": false,
  "accountSuspended": true,
  "organizationStatus": "suspended",
  "message": "Your organization workspace (Acme Technologies Inc.) is currently suspended. Please contact SalesBuster administrator."
}
```

#### 2. When Organization is Inactive (`403 Forbidden`)
```json
{
  "success": false,
  "accountSuspended": true,
  "organizationStatus": "inactive",
  "message": "Your organization workspace (Acme Technologies Inc.) is currently inactive. Please contact SalesBuster administrator."
}
```

#### 3. When Organization Subscription is Expired (`403 Forbidden`)
```json
{
  "success": false,
  "subscriptionExpired": true,
  "message": "Your organization's subscription expired on 01 Dec 2026. Please contact SalesBuster administrator to renew."
}
```

#### 4. When Individual Representative Account is Inactive (`403 Forbidden`)
```json
{
  "success": false,
  "accountSuspended": true,
  "message": "Your user account is deactivated. Please contact your administrator."
}
```

---

### 10.3 Organization Status in the Login Response (`/auth/login`)

When a user logs in successfully, the `organization` object in the response body always includes live status flags:

```json
{
  "success": true,
  "_id": "66dd0a1b2c3d4e5f6a7b8c90",
  "name": "John Doe",
  "email": "salesrep@acmetech.io",
  "role": "sales person",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "organization": {
    "id": "66dd0a1a2c3d4e5f6a7b8c8f",
    "name": "Acme Technologies Inc.",
    "seats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-01T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-01T23:59:59.999Z",
    "status": "active",
    "isExpired": false,
    "isOrgOwner": false
  }
}
```

- **`status`**: `"active" | "inactive" | "suspended"`
- **`isExpired`**: `true | false`
- **`subscriptionEndDate`**: ISO 8601 timestamp string
- **`remainingSeats`**: Number of available user licenses

---

### 10.4 Mobile App Axios / Fetch Global Interceptor Example

In your mobile application, set up a global response interceptor to handle account suspension, expired subscriptions, and token expiration automatically:

```javascript
import axios from "axios";
import { navigate } from "./navigationRef"; // Your mobile navigation handler

const apiClient = axios.create({
  baseURL: "https://api.salesbuster.ai/api",
  timeout: 15000,
});

// Attach JWT Token to every outgoing request
apiClient.interceptors.request.use((config) => {
  const token = getStoredAuthToken(); // From SecureStorage / AsyncStorage
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Global Error Interceptor for Subscription & Organization Status
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const { status, data } = error.response;

      // 1. Subscription Expired
      if (status === 403 && data.subscriptionExpired) {
        navigate("SubscriptionExpiredScreen", {
          message: data.message,
        });
        return Promise.reject(error);
      }

      // 2. Organization Suspended or Inactive
      if (status === 403 && data.accountSuspended) {
        navigate("AccountSuspendedScreen", {
          status: data.organizationStatus || "suspended",
          message: data.message,
        });
        return Promise.reject(error);
      }

      // 3. Token Expired or Invalid
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

