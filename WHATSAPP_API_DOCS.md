# WhatsApp API Documentation (Sales Manager vs Sales Person)

This document details the non-cloud WhatsApp APIs (Baileys Web Multi-Device QR Connection) partitioned specifically by user roles: **Sales Manager** (and Super Admin / Organization Owner) vs **Sales Person** (Sales Representative).

---

## 1. Role & Permission Matrix

| Feature / Endpoint | Method | Route | Sales Manager / Admin | Sales Person (Sales Rep) |
| :--- | :--- | :--- | :--- | :--- |
| **Connect WhatsApp** | `POST` | `/api/whatsapp/connect` | Connects Org Line 1 or Line 2 (`org_<orgId>`) | Connects Personal Rep Line (`org_<orgId>_user_<userId>`) |
| **Get Connection Status** | `GET` | `/api/whatsapp/status` | Views all Org Lines (Line 1 & Line 2) | Views ONLY their personal line |
| **Get QR Code** | `GET` | `/api/whatsapp/qr` | Gets QR for Org Line 1 or 2 | Gets QR for their personal line |
| **Logout / Disconnect** | `POST` | `/api/whatsapp/logout` | Disconnects Org Line 1 or 2 | Disconnects ONLY their personal line |
| **Team Connection Overview** | `GET` | `/api/whatsapp/team-status` | Allowed (Full overview of all reps) | `403 Forbidden` |
| **View Conversations** | `GET` | `/api/whatsapp/conversations` | All organization conversations | ONLY leads assigned to this rep |
| **View Lead Messages** | `GET` | `/api/whatsapp/conversation/:leadId` | Can view any conversation | ONLY if assigned to this rep (`403` otherwise) |
| **Send WhatsApp Message** | `POST` | `/api/whatsapp/message/send` | View-only on rep leads; sends on unassigned | Sends via personal line to assigned leads |
| **Toggle AI on Lead** | `POST` | `/api/whatsapp/ai/toggle` | Any lead in organization | ONLY leads assigned to this rep |
| **Summarize Conversation** | `POST` | `/api/whatsapp/conversation/:leadId/summarize` | Any lead in organization | ONLY leads assigned to this rep |
| **Test AI Simulator** | `POST` / `GET` | `/api/whatsapp/test-ai` | Allowed (Simulator & reset) | `403 Forbidden` |
| **View WhatsApp Settings** | `GET` | `/api/whatsapp/settings` | Allowed | Allowed (Read-only) |
| **Update WhatsApp Settings** | `POST` | `/api/whatsapp/settings` | Allowed | `403 Forbidden` |

---

## 2. Authentication & Test Tokens

Both roles use standard JWT Bearer tokens with their respective role embedded:
```http
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

- **Manager Token Payload:** `{ "_id": "66ef1111b4c5d6e7f8a9b001", "role": "sales manager", "organizationId": "66ef12a3b4c5d6e7f8a9b0c1" }`
- **Sales Person Token Payload:** `{ "_id": "66ef19f2b4c5d6e7f8a9b0d5", "role": "sales person", "organizationId": "66ef12a3b4c5d6e7f8a9b0c1", "phone": "919876543211" }`

---

## 3. Sales Manager APIs

The Sales Manager operates organization-level WhatsApp lines (Device 1 & Device 2) and oversees the sales team.

---

### 3.1 Manager: Connect Organization Line
Connects the shared organization WhatsApp device (Line 1 or Line 2) and generates a QR code session.

- **Route:** `POST /api/whatsapp/connect`
- **Access:** Sales Manager / Super Admin

#### cURL (Connect Line 1)
```bash
curl -X POST http://localhost:5000/api/whatsapp/connect \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "device": 1
  }'
```

#### cURL (Connect Line 2 - Dual-Line Plans)
```bash
curl -X POST http://localhost:5000/api/whatsapp/connect \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "device": 2
  }'
```

#### Response (`200 OK`)
```json
{
  "message": "WhatsApp connection worker started.",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1"
}
```

---

### 3.2 Manager: Get Org Lines Status
Returns the connection state (`connected`, `qr`, `connecting`, `disconnected`) of all company lines (`Device 1` and `Device 2`).

- **Route:** `GET /api/whatsapp/status`
- **Access:** Sales Manager / Super Admin

#### cURL
```bash
curl -X GET http://localhost:5000/api/whatsapp/status \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
{
  "sessions": [
    {
      "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1",
      "organizationId": "66ef12a3b4c5d6e7f8a9b0c1",
      "status": "connected",
      "qrCode": "",
      "connectedPhone": "919876543210",
      "connectedName": "Holy Mini Cow Official",
      "isPrimary": true,
      "label": "Device 1 (Primary)"
    },
    {
      "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_device_2",
      "organizationId": "66ef12a3b4c5d6e7f8a9b0c1",
      "status": "disconnected",
      "qrCode": "",
      "connectedPhone": "",
      "connectedName": "",
      "isPrimary": false,
      "label": "Device 2 (Secondary)"
    }
  ],
  "whatsappLineLimit": 2
}
```

---

### 3.3 Manager: Get QR Code for Org Line
Fetches the active QR code image string (base64 data URL) to scan from the WhatsApp mobile app.

- **Route:** `GET /api/whatsapp/qr?device=1`
- **Access:** Sales Manager / Super Admin

#### cURL
```bash
curl -X GET "http://localhost:5000/api/whatsapp/qr?device=1" \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIEAYAAAD9x...",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1"
}
```

---

### 3.4 Manager: Logout Org Line
Disconnects a company device and clears its stored authentication credentials.

- **Route:** `POST /api/whatsapp/logout`
- **Access:** Sales Manager / Super Admin

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/logout \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "device": 1
  }'
```

#### Response (`200 OK`)
```json
{
  "message": "WhatsApp disconnected and logged out successfully.",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1"
}
```

---

### 3.5 Manager: Team WhatsApp Connection Overview
Displays real-time WhatsApp connectivity for all sales reps in the organization.

- **Route:** `GET /api/whatsapp/team-status`
- **Access:** Sales Manager / Super Admin only

#### cURL
```bash
curl -X GET http://localhost:5000/api/whatsapp/team-status \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "userId": "66ef19f2b4c5d6e7f8a9b0d5",
      "name": "Kranthi Kumar",
      "email": "kranthi@company.com",
      "profilePhone": "919876543211",
      "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef19f2b4c5d6e7f8a9b0d5",
      "status": "connected",
      "connectedPhone": "919876543211",
      "connectedName": "Kranthi",
      "lastSeen": "2026-10-05T12:30:00.000Z",
      "errorMessage": ""
    },
    {
      "userId": "66ef20a1b4c5d6e7f8a9b0e7",
      "name": "Anil Reddy",
      "email": "anil@company.com",
      "profilePhone": "919876543212",
      "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef20a1b4c5d6e7f8a9b0e7",
      "status": "disconnected",
      "connectedPhone": "",
      "connectedName": "",
      "lastSeen": null,
      "errorMessage": "Device disconnected from phone."
    }
  ]
}
```

---

### 3.6 Manager: View All Conversations (With Rep Filtering)
Managers can view all organization conversations and optionally filter by sales rep.

- **Route:** `GET /api/whatsapp/conversations`
- **Access:** Sales Manager / Super Admin
- **Query Params:** `?userId=<REP_ID>` or `?name=<REP_NAME>`

#### cURL (All Conversations)
```bash
curl -X GET http://localhost:5000/api/whatsapp/conversations \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>"
```

#### cURL (Filter by Specific Sales Rep)
```bash
curl -X GET "http://localhost:5000/api/whatsapp/conversations?userId=66ef19f2b4c5d6e7f8a9b0d5" \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
[
  {
    "_id": "6701a2b3c4d5e6f7a8b9c0d1",
    "leadId": {
      "_id": "6701a0a1b2c3d4e5f6a7b8c9",
      "name": "Ramesh Sharma",
      "phone": "919876543210",
      "service": "Punganur Cow",
      "status": "Follow Up",
      "assignedTo": "66ef19f2b4c5d6e7f8a9b0d5"
    },
    "lastMessage": "We have pure Punganur cows ready for dispatch.",
    "lastMessageTime": "2026-10-05T12:50:00.000Z",
    "unreadCount": 0
  }
]
```

---

### 3.7 Manager: View-Only Rule on Rep Conversations
If a manager attempts to send a message to a lead assigned to a sales representative, the system enforces a strict **View-Only guardrail**.

- **Route:** `POST /api/whatsapp/message/send`
- **Access:** Sales Manager / Super Admin

#### cURL (Attempt to send message on Rep's lead)
```bash
curl -X POST http://localhost:5000/api/whatsapp/message/send \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "6701a0a1b2c3d4e5f6a7b8c9",
    "text": "Hello from manager"
  }'
```

#### Guardrail Response (`403 Forbidden`)
```json
{
  "message": "Administrators have View-Only access to sales representative WhatsApp conversations. Only the assigned Sales Representative can send messages."
}
```

---

### 3.8 Manager: Test AI Simulation Engine
Simulates incoming customer messages without needing a real WhatsApp phone.

- **Route:** `POST /api/whatsapp/test-ai`
- **Access:** Sales Manager / Super Admin only

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/test-ai \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Do you have Punganur cows under 3 feet height? I am in Chennai."
  }'
```

#### Response (`200 OK`)
```json
{
  "incoming": {
    "_id": "6701c101b2c3d4e5f6a7b901",
    "text": "Do you have Punganur cows under 3 feet height? I am in Chennai.",
    "direction": "incoming",
    "timestamp": "2026-10-05T13:00:00.000Z"
  },
  "outgoing": {
    "_id": "6701c105b2c3d4e5f6a7b902",
    "text": "Yes! Our purebred Punganur dwarf cows are typically 2.2 to 2.8 feet in height. We can arrange safe transport to Chennai.",
    "direction": "outgoing",
    "timestamp": "2026-10-05T13:00:04.000Z"
  },
  "aiQualification": {
    "city": "Chennai",
    "intent": "Punganur Cow",
    "interestScore": 8
  },
  "leadId": "6701b901b2c3d4e5f6a7b8e1"
}
```

---

### 3.9 Manager: Update Global WhatsApp Settings
Controls master AI automation and automated welcome templates.

- **Route:** `POST /api/whatsapp/settings`
- **Access:** Sales Manager / Super Admin only

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/settings \
  -H "Authorization: Bearer <MANAGER_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "globalAIEnabled": true,
    "welcomeMessageTemplate": "Hello {name}! Welcome to {companyName}. We received your enquiry for {service}.",
    "welcomeMessageFallbackService": "Punganur Mini Cow"
  }'
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "globalAIEnabled": true,
    "welcomeMessageTemplate": "Hello {name}! Welcome to {companyName}. We received your enquiry for {service}.",
    "welcomeMessageFallbackService": "Punganur Mini Cow",
    "updatedBy": "Sales Manager",
    "updatedAt": "2026-10-05T13:05:00.000Z"
  }
}
```

---

## 4. Sales Person (Sales Rep) APIs

Sales Representatives connect their own individual WhatsApp phone lines (`org_<orgId>_user_<userId>`) via QR code and communicate strictly with leads assigned to them.

---

### 4.1 Sales Person: Connect Personal WhatsApp Line
Starts the Baileys connection worker strictly for the logged-in sales rep's dedicated personal line.

- **Route:** `POST /api/whatsapp/connect`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/connect \
  -H "Authorization: Bearer <REP_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

#### Response (`200 OK`)
```json
{
  "message": "WhatsApp connection started for your personal line. Please scan the QR code when it appears.",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef19f2b4c5d6e7f8a9b0d5"
}
```

---

### 4.2 Sales Person: Get Personal Line Status
Returns only their personal line status.

- **Route:** `GET /api/whatsapp/status`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X GET http://localhost:5000/api/whatsapp/status \
  -H "Authorization: Bearer <REP_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
{
  "sessions": [
    {
      "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef19f2b4c5d6e7f8a9b0d5",
      "organizationId": "66ef12a3b4c5d6e7f8a9b0c1",
      "status": "connected",
      "qrCode": "",
      "connectedPhone": "919876543211",
      "connectedName": "Kranthi",
      "isPrimary": true,
      "label": "My WhatsApp Line",
      "isRepSession": true,
      "expectedPhone": "919876543211",
      "errorMessage": ""
    }
  ],
  "isRepSession": true,
  "whatsappLineLimit": 1
}
```

---

### 4.3 Sales Person: Get Personal Line QR Code
Retrieves QR code strictly for their personal session to scan using WhatsApp on their phone.

- **Route:** `GET /api/whatsapp/qr`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X GET http://localhost:5000/api/whatsapp/qr \
  -H "Authorization: Bearer <REP_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIEAYAAAD9x...",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef19f2b4c5d6e7f8a9b0d5"
}
```

*Note:* If a sales rep passes an organization session in `?sessionId=org_...`, they receive `403 Forbidden`:
```json
{
  "message": "Access denied. Sales representatives can only access their own WhatsApp session QR code.",
  "qrCode": ""
}
```

---

### 4.4 Sales Person: Disconnect Personal Line
Disconnects only the logged-in sales rep's WhatsApp session and deletes stored authentication tokens.

- **Route:** `POST /api/whatsapp/logout`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/logout \
  -H "Authorization: Bearer <REP_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

#### Response (`200 OK`)
```json
{
  "message": "Your WhatsApp line has been disconnected successfully.",
  "sessionId": "org_66ef12a3b4c5d6e7f8a9b0c1_user_66ef19f2b4c5d6e7f8a9b0d5"
}
```

---

### 4.5 Sales Person: View Assigned Conversations
Returns ONLY conversation threads for leads assigned to the authenticated sales rep.

- **Route:** `GET /api/whatsapp/conversations`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X GET http://localhost:5000/api/whatsapp/conversations \
  -H "Authorization: Bearer <REP_JWT_TOKEN>"
```

#### Response (`200 OK`)
```json
[
  {
    "_id": "6701a2b3c4d5e6f7a8b9c0d1",
    "leadId": {
      "_id": "6701a0a1b2c3d4e5f6a7b8c9",
      "name": "Ramesh Sharma",
      "phone": "919876543210",
      "service": "Punganur Cow",
      "assignedTo": "66ef19f2b4c5d6e7f8a9b0d5"
    },
    "lastMessage": "Can you share the photo of the cow?",
    "lastMessageTime": "2026-10-05T12:48:00.000Z",
    "unreadCount": 1
  }
]
```

---

### 4.6 Sales Person: View Messages for an Assigned Lead
Retrieves conversation history. If the lead is assigned to another sales rep, access is blocked.

- **Route:** `GET /api/whatsapp/conversation/:leadId`
- **Access:** Protected (Sales Person)

#### cURL (Assigned Lead)
```bash
curl -X GET http://localhost:5000/api/whatsapp/conversation/6701a0a1b2c3d4e5f6a7b8c9 \
  -H "Authorization: Bearer <REP_JWT_TOKEN>"
```

#### Success Response (`200 OK`)
```json
[
  {
    "_id": "6701a2c4e5f6a7b8c9d0e1f2",
    "messageId": "3EB0ABC123456789DEF0",
    "leadId": "6701a0a1b2c3d4e5f6a7b8c9",
    "sender": "919876543210",
    "senderName": "Ramesh Sharma",
    "direction": "incoming",
    "messageType": "text",
    "text": "Can you share the photo of the cow?",
    "timestamp": "2026-10-05T12:48:00.000Z"
  }
]
```

#### Error Response (Lead Not Assigned to Rep - `403 Forbidden`)
```json
{
  "message": "Access denied. You are not assigned to this conversation."
}
```

---

### 4.7 Sales Person: Send Manual WhatsApp Message
Dispatches a manual message from the sales rep's personal WhatsApp line to their assigned lead. Automatically pauses AI replies for 5 minutes (`aiPausedUntil`).

- **Route:** `POST /api/whatsapp/message/send`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/message/send \
  -H "Authorization: Bearer <REP_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "6701a0a1b2c3d4e5f6a7b8c9",
    "text": "Hello Ramesh! I am sending you the video and certificate of the Punganur calf right away."
  }'
```

#### Success Response (`200 OK`)
```json
{
  "_id": "6701b5a1b2c3d4e5f6a7b8f9",
  "messageId": "3EB0FED987654321CBA0",
  "leadId": "6701a0a1b2c3d4e5f6a7b8c9",
  "sender": "Sales Representative",
  "senderName": "Kranthi",
  "direction": "outgoing",
  "messageType": "text",
  "text": "Hello Ramesh! I am sending you the video and certificate of the Punganur calf right away.",
  "timestamp": "2026-10-05T12:50:00.000Z",
  "aiGenerated": false,
  "status": "sent"
}
```

#### Error Response (Unassigned Lead - `403 Forbidden`)
```json
{
  "message": "Access denied. You are only authorized to send messages to leads assigned to you."
}
```

---

### 4.8 Sales Person: Toggle AI on Assigned Lead
Enables or disables AI for an assigned lead.

- **Route:** `POST /api/whatsapp/ai/toggle`
- **Access:** Protected (Sales Person)

#### cURL
```bash
curl -X POST http://localhost:5000/api/whatsapp/ai/toggle \
  -H "Authorization: Bearer <REP_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "6701a0a1b2c3d4e5f6a7b8c9",
    "aiEnabled": false
  }'
```

#### Success Response (`200 OK`)
```json
{
  "message": "AI response state set to false for Ramesh Sharma",
  "lead": {
    "_id": "6701a0a1b2c3d4e5f6a7b8c9",
    "name": "Ramesh Sharma",
    "aiEnabled": false
  }
}
```

#### Error Response (Unassigned Lead - `403 Forbidden`)
```json
{
  "message": "Access denied: You are not assigned to this lead."
}
```

---

### 4.9 Sales Person: Restricted Endpoints
The following endpoints reject Sales Persons with `403 Forbidden`:

1. **Team Status Overview (`GET /api/whatsapp/team-status`)**:
   ```json
   { "success": false, "message": "Access denied." }
   ```
2. **AI Simulation Test (`POST /api/whatsapp/test-ai`)**:
   ```json
   { "message": "Access denied: Only managers and administrators can access AI testing." }
   ```
3. **Update Global Settings (`POST /api/whatsapp/settings`)**:
   ```json
   { "success": false, "message": "Access denied: Only managers or administrators can update global WhatsApp settings." }
   ```
