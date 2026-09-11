# SalesBuster Website Chat & Meeting Booking API Guide

This document provides complete documentation and ready-to-run `curl` commands for the **Website AI Chat, Lead Capture, and Calendly Meeting Booking** flow.

---

## 📌 Overview & Target Configuration

- **Base URL**: `http://localhost:5000` *(or production `https://api.salesbuster.ai`)*
- **Target Organization / Tenant DB**: `sb_tenant_salesbuster_9f3f71`
- **Lead Source**: `"Website Chat"`
- **RAG Knowledge Base**: Qdrant collection `salesbuster_kb` + Gemini AI

---

## 1. Chat with AI (Requirement Discovery & Product Q&A)

Sends a visitor message to the SalesBuster AI. The assistant consultatively discovers requirements, answers platform and pricing questions from the knowledge base, captures contact details, and suggests booking a live demo.

- **Method**: `POST`
- **Path**: `/api/static-chat`
- **Headers**: `Content-Type: application/json`

### Request Payload
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `message` | `string` | **Yes** | The message entered by the website visitor |
| `sessionId` | `string` | No | Unique session ID (e.g. `sb_visitor_12345`). Persists conversation turns. |
| `leadDetails` | `object` | No | Any previously captured lead fields (`name`, `company`, `phone`, `email`) |

### cURL (Bash / Mac / Linux)
```bash
curl -X POST http://localhost:5000/api/static-chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hi, I am Rahul Sharma from Apex Realty. We have 8 sales reps and need WhatsApp CRM with call recording. Phone: 9876543210, Email: rahul@apexrealty.com",
    "sessionId": "sb_visitor_12345"
  }'
```

### cURL (Windows PowerShell)
```powershell
curl.exe -X POST "http://localhost:5000/api/static-chat" `
  -H "Content-Type: application/json" `
  -d '{\"message\": \"Hi, I am Rahul Sharma from Apex Realty. We have 8 sales reps and need WhatsApp CRM with call recording. Phone: 9876543210, Email: rahul@apexrealty.com\", \"sessionId\": \"sb_visitor_12345\"}'
```

### Success Response (`200 OK`)
```json
{
  "reply": "Hello Rahul! 👋 Welcome to SalesBuster. For a real estate team of 8 reps, SalesBuster is an ideal fit because:\n- **Android Call Recording**: All sales calls are automatically logged, recorded, and transcribed with AI summaries.\n- **WhatsApp CRM**: Centralized WhatsApp inbox with automated lead assignment so no buyer enquiry goes missed.\n- **Pricing**: Base Pack of 5 licenses (₹5,995/mo quarterly) + 3 additional user licenses (₹1,199/user/mo).\n\nWould you like me to schedule a quick 1-on-1 demo for your team?",
  "sessionId": "sb_visitor_12345",
  "extractedLead": {
    "name": "Rahul Sharma",
    "company": "Apex Realty",
    "phone": "9876543210",
    "email": "rahul@apexrealty.com",
    "requirement": "WhatsApp CRM with call recording for 8 sales reps"
  },
  "suggestCalendly": true,
  "leadId": "66e1b5c490a789c123456789",
  "hasCapturedContact": true
}
```

---

## 2. Capture Lead Details (Direct In-Chat Card Submission)

Called when the visitor submits the interactive mini-form inside the chat widget (**Name, Company, Mobile, Email, Requirement**). Immediately creates/updates the lead in `sb_tenant_salesbuster_9f3f71`, assigns a sales rep via round-robin, saves chat history, and triggers real-time CRM notifications.

- **Method**: `POST`
- **Path**: `/api/static-chat/capture-lead`
- **Headers**: `Content-Type: application/json`

### Request Payload
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Yes** | Visitor's full name |
| `company` | `string` | **Yes** | Company / business name |
| `mobile` | `string` | **Yes** | 10-digit mobile number |
| `email` | `string` | **Yes** | Work email address |
| `requirement` | `string` | No | Business requirement or inquiry description |
| `sessionId` | `string` | No | Chat session ID to link conversation history |

### cURL (Bash / Mac / Linux)
```bash
curl -X POST http://localhost:5000/api/static-chat/capture-lead \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sb_visitor_12345",
    "name": "Priya Verma",
    "company": "Zenith Realtech",
    "mobile": "9812345678",
    "email": "priya@zenithrealtech.com",
    "requirement": "Need WhatsApp automation and daily telecaller analytics for 12 agents"
  }'
```

### cURL (Windows PowerShell)
```powershell
curl.exe -X POST "http://localhost:5000/api/static-chat/capture-lead" `
  -H "Content-Type: application/json" `
  -d '{\"sessionId\": \"sb_visitor_12345\", \"name\": \"Priya Verma\", \"company\": \"Zenith Realtech\", \"mobile\": \"9812345678\", \"email\": \"priya@zenithrealtech.com\", \"requirement\": \"Need WhatsApp automation and daily telecaller analytics for 12 agents\"}'
```

### Success Response (`200 OK`)
```json
{
  "success": true,
  "leadId": "66e1b6f090a789c123456790",
  "lead": {
    "_id": "66e1b6f090a789c123456790",
    "name": "Priya Verma",
    "company": "Zenith Realtech",
    "phone": "9812345678",
    "email": "priya@zenithrealtech.com",
    "service": "WhatsApp Automation",
    "source": "Website Chat",
    "status": "New",
    "assignedTo": "66d89a2412e4f01234567890",
    "notes": "Requirement: Need WhatsApp automation and daily telecaller analytics for 12 agents | Company: Zenith Realtech",
    "tags": ["Website Chat"]
  }
}
```

---

## 3. Record Calendly Demo Booking

Triggered when the visitor completes a 1-on-1 meeting booking in Calendly (`calendly.event_scheduled`). Updates lead status to `"Converted"`, records appointment date/time, and tags the lead with `"Demo Booked"`.

- **Method**: `POST`
- **Path**: `/api/static-chat/calendly-scheduled`
- **Headers**: `Content-Type: application/json`

### Request Payload
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sessionId` | `string` | No | Chat session ID |
| `leadId` | `string` | No | Existing CRM Lead ID if known |
| `appointmentDate` | `string` | No | Appointment date (`YYYY-MM-DD`) |
| `appointmentTime` | `string` | No | Appointment time string (e.g. `03:30 PM`) |
| `notes` | `string` | No | Notes regarding the demo booking |

### cURL (Bash / Mac / Linux)
```bash
curl -X POST http://localhost:5000/api/static-chat/calendly-scheduled \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sb_visitor_12345",
    "leadId": "66e1b6f090a789c123456790",
    "appointmentDate": "2026-09-15",
    "appointmentTime": "03:30 PM",
    "notes": "1-on-1 live product demo scheduled via Calendly"
  }'
```

### cURL (Windows PowerShell)
```powershell
curl.exe -X POST "http://localhost:5000/api/static-chat/calendly-scheduled" `
  -H "Content-Type: application/json" `
  -d '{\"sessionId\": \"sb_visitor_12345\", \"leadId\": \"66e1b6f090a789c123456790\", \"appointmentDate\": \"2026-09-15\", \"appointmentTime\": \"03:30 PM\", \"notes\": \"1-on-1 live product demo scheduled via Calendly\"}'
```

### Success Response (`200 OK`)
```json
{
  "success": true,
  "leadId": "66e1b6f090a789c123456790",
  "appointmentDetails": {
    "appointmentDate": "2026-09-15",
    "appointmentTime": "03:30 PM",
    "notes": "1-on-1 live product demo scheduled via Calendly"
  }
}
```

---

## 4. Get Widget Runtime Configuration

Returns public settings including the Calendly URL and default quick action suggestion chips.

- **Method**: `GET`
- **Path**: `/api/static-chat/config`

### cURL
```bash
curl -X GET http://localhost:5000/api/static-chat/config
```

### Success Response (`200 OK`)
```json
{
  "companyName": "SalesBuster AI",
  "calendlyUrl": "https://calendly.com/team-salesbuster/30min",
  "defaultChips": [
    {
      "label": "⚡ Core Features",
      "query": "What are the core features of SalesBuster CRM?"
    },
    {
      "label": "💰 Pricing & Plans",
      "query": "How much does SalesBuster cost and what plans are available?"
    },
    {
      "label": "📅 Book a 1-on-1 Demo",
      "query": "I want to schedule a live product demo."
    },
    {
      "label": "📝 Share Requirement",
      "query": "I'd like to share my team's CRM and sales automation requirements."
    }
  ]
}
```

---

## 5. Get Session Chat History

Retrieves historical messages for a given session.

- **Method**: `GET`
- **Path**: `/api/static-chat/history?sessionId={SESSION_ID}`

### cURL
```bash
curl -X GET "http://localhost:5000/api/static-chat/history?sessionId=sb_visitor_12345"
```

### Success Response (`200 OK`)
```json
{
  "history": [
    {
      "role": "user",
      "text": "How much does SalesBuster cost?",
      "timestamp": "2026-09-11T11:50:00.000Z"
    },
    {
      "role": "assistant",
      "text": "SalesBuster offers two transparent plans for the Base Pack (5 user licenses)...",
      "timestamp": "2026-09-11T11:50:02.000Z"
    }
  ]
}
```

---

## 6. Reset Session

Clears the session when the visitor clicks "New Chat".

- **Method**: `POST`
- **Path**: `/api/static-chat/reset`
- **Headers**: `Content-Type: application/json`

### cURL
```bash
curl -X POST http://localhost:5000/api/static-chat/reset \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sb_visitor_12345"}'
```

### Success Response (`200 OK`)
```json
{
  "message": "Session reset successfully."
}
```

---

## 7. Static Assets & Demo URLs

- **Embeddable Chat Widget Script**:
  ```html
  <script src="http://localhost:5000/api/static-chat/widget.js"></script>
  ```
- **Interactive Live Preview Demo**:
  Open in browser: `http://localhost:5000/api/static-chat/demo`
