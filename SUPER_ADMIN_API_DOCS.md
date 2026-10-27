# SalesBuster CRM — Super Admin REST API Documentation

This document provides ready-to-use **cURL commands**, request payloads, query parameters, headers, and full sample JSON responses for all Super Admin and Administrative endpoints. These APIs are designed for your **separate Super Admin project / portal** to provision tenant organizations, manage user seat capacity, renew subscriptions, toggle modular add-ons, configure AI assistants, manage Qdrant knowledge bases, split conversation quotas, and distribute mobile app APK releases.

---

## Base URLs & Authentication

- **Production Base URL**: `https://betaapi.salesbuster.ai/api`
- **Local Dev Base URL**: `http://localhost:5000/api`

### Authentication Methods

All Super Admin endpoints support either of the following authentication methods:

1. **Admin Secret API Key (Recommended for Admin Backend / Service-to-Service)**:
   - Header: `x-admin-key: salesbuster_super_admin_secret_key_2026`
   - *(Configurable via `ADMIN_API_KEY` in the backend `.env` file)*

2. **Bearer JWT Token (For logged-in Super Admin users)**:
   - Header: `Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>`
   - Obtained via the `/api/auth/login` endpoint with `role: "super_admin"`.

---

## Quick Reference API Sitemap

| # | Endpoint | Method | Auth | Description |
|---|---|---|---|---|
| **1** | `/api/auth/login` | `POST` | Public | Super Admin authentication & JWT token generation |
| **2** | `/api/organizations/provision` or `/api/organizations` | `POST` | Super Admin | Provision new isolated tenant DB & send welcome credentials |
| **3** | `/api/organizations` | `GET` | Super Admin | List all organizations with live seat & subscription metrics |
| **4** | `/api/organizations/:id` | `GET` | Super Admin | Fetch deep details for a single organization |
| **5** | `/api/organizations/:id/seats` | `PUT` | Super Admin | Upgrade or downgrade licensed sales representative seats |
| **6** | `/api/organizations/:id/renew` | `PUT` | Super Admin | Renew subscription duration (`monthly`, `quarterly`, `annually`) |
| **7** | `/api/organizations/:id/status` | `PATCH` | Super Admin | Suspend or activate tenant access |
| **8** | `/api/organizations/:id/resend-welcome` | `POST` | Super Admin | Regenerate credentials & resend welcome onboarding email |
| **9** | `/api/organizations/:id/whatsapp-limit` | `PUT` | Super Admin | Set WhatsApp connection limit (1 Single Line vs 2 Dual Lines) |
| **10** | `/api/organizations/:id/addons` | `PUT` | Super Admin | Enable/disable add-ons (`whatsappCampaigns`, `biAnalyst`) |
| **11** | `/api/organizations/:id/ai-settings` | `GET` | Super Admin | Fetch tenant AI settings, Gemini key status, & usage |
| **12** | `/api/organizations/:id/ai-settings` | `PUT` | Super Admin | Update tenant AI configuration, Gemini API key, & templates |
| **13** | `/api/organizations/:id/knowledge-base/upload` | `POST` | Super Admin | Upload & embed document into tenant Qdrant vector store |
| **14** | `/api/organizations/:id/knowledge-base/:docId` | `DELETE` | Super Admin | Remove document from tenant Qdrant vector collection |
| **15** | `/api/organizations/my-org/quota-split` | `PUT` | Manager / Owner / Super Admin | Partition daily 500 quota across WhatsApp, Calls, & BI Analyst |
| **16** | `/api/organizations/my-org` | `GET` | Org Owner / Manager | Retrieve tenant owner organization profile & metrics |
| **17** | `/api/app-release/upload` | `POST` | Super Admin | Upload new Android APK (auto-replaces previous binary) |
| **18** | `/api/app-release/latest` | `GET` | Public | Inspect current active APK version and metadata |
| **19** | `/api/mobile-app/apk/download` or `/api/app-release/download` | `GET` | Public | Direct Android APK binary file download |
| **20** | `/api/app-release` | `DELETE` | Super Admin | Delete active APK file from disk and clear release record |

---

## 1. Super Admin Authentication & Login

Logs in the Super Administrator and returns a Bearer JWT Token with `role: "super_admin"`. This token can be used in the `Authorization: Bearer <TOKEN>` header for all subsequent administrative endpoints.

### Endpoints:
- `POST /api/auth/login`

### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@gmail",
    "password": "your_secure_password"
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "_id": "66dd0a1b2c3d4e5f6a7b8c90",
  "name": "SalesBuster Super Admin",
  "email": "admin@gmail",
  "role": "super_admin",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2ZGQwYTFiMmMzZDRlNWY2YTdiOGM5MCIsImVtYWlsIjoiYWRtaW5AZ21haWwiLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJ0ZW5hbnREYk5hbWUiOm51bGwsIm9yZ2FuaXphdGlvbklkIjpudWxsLCJpc09yZ093bmVyIjpmYWxzZSwiaWF0IjoxNzI1NzA4NDAwLCJleHAiOjE3MjgzMDA0MDB9.signature",
  "tenantDbName": null,
  "organization": null
}
```

---

## 2. Provision New Organization Tenant

Creates an isolated client tenant, initializes their private database (`sb_tenant_<slug>_<id>`), auto-generates a secure password, calculates subscription validity according to the plan (`monthly` &rarr; +1 mo, `quarterly` &rarr; +3 mos, `annually` &rarr; +12 mos), initializes the 500 daily conversation quota, and dispatches the welcome onboarding email.

> [!NOTE]
> **No Password Required**: Do **not** send a password in the request. The backend auto-generates a complex random password and emails it to the owner.

### Supported Subscription Plans:
- `"monthly"`: 1 calendar month validity (default)
- `"quarterly"`: 3 calendar months validity
- `"annually"`: 12 calendar months validity

### Endpoints:
- `POST /api/organizations`
- `POST /api/organizations/provision`

### cURL Request (Using Super Admin Bearer JWT Token):

```bash
curl -X POST https://betaapi.salesbuster.ai/api/organizations/provision \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>" \
  -d '{
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "amountPaid": 5990,
    "pricingPerSeat": 599,
    "paymentMethod": "UPI",
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "whatsappLineLimit": 2,
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    },
    "notes": "Enterprise Tier client"
  }'
```

### Alternative cURL Request (Using Admin Secret Key):

```bash
curl -X POST https://betaapi.salesbuster.ai/api/organizations/provision \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "amountPaid": 5990,
    "pricingPerSeat": 599,
    "paymentMethod": "UPI",
    "subscriptionPlan": "quarterly",
    "whatsappLineLimit": 2,
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    }
  }'
```

### Success Response (`201 Created`):

```json
{
  "success": true,
  "message": "Tenant organization provisioned successfully. Welcome email with credentials dispatched.",
  "data": {
    "organization": {
      "id": "66dd1f5e8b4e7a2b9c1d0001",
      "name": "Acme Technologies Inc.",
      "email": "billing@acmetech.io",
      "mobile": "+91 98765 43210",
      "website": "https://acmetech.io",
      "seats": 10,
      "amountPaid": 5990,
      "pricingPerSeat": 599,
      "subscriptionPlan": "quarterly",
      "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
      "subscriptionEndDate": "2026-12-08T23:59:59.999Z",
      "whatsappLineLimit": 2,
      "addons": {
        "whatsappCampaigns": true,
        "biAnalyst": true
      },
      "status": "active",
      "tenantDbName": "sb_tenant_acme_technologies_7cfcaa"
    },
    "emailSent": true,
    "credentials": {
      "email": "billing@acmetech.io",
      "temporaryPassword": "Acme#5f53004e@",
      "loginUrl": "https://crm.salesbuster.com/login"
    }
  }
}
```

---

## 3. Get All Organizations (With Live Seat & Quota Metrics)

Returns a list of all client organizations with live seat utilization (`usedSeats / totalSeats`), remaining available seats, active add-on flags, and subscription expiry flags.

### Endpoints:
- `GET /api/organizations`

### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organizations \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": "66dd1f5e8b4e7a2b9c1d0001",
      "name": "Acme Technologies Inc.",
      "email": "billing@acmetech.io",
      "mobile": "+91 98765 43210",
      "website": "https://acmetech.io",
      "seats": 10,
      "usedSeats": 4,
      "remainingSeats": 6,
      "amountPaid": 5990,
      "pricingPerSeat": 599,
      "subscriptionPlan": "quarterly",
      "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
      "subscriptionEndDate": "2026-12-08T23:59:59.999Z",
      "status": "active",
      "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
      "whatsappLineLimit": 2,
      "addons": {
        "whatsappCampaigns": true,
        "biAnalyst": true
      },
      "dailyAiUsage": {
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
      "createdAt": "2026-09-08T06:30:00.000Z"
    }
  ]
}
```

---

## 4. Get Single Organization Details

Fetches deep metrics and operational settings for a single organization by its ID.

### Endpoints:
- `GET /api/organizations/:id`

### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001 \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "amountPaid": 5990,
    "pricingPerSeat": 599,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-08T23:59:59.999Z",
    "status": "active",
    "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
    "ownerId": "66dd1f5e8b4e7a2b9c1d0000",
    "whatsappLineLimit": 2,
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    },
    "isExpired": false,
    "createdAt": "2026-09-08T06:30:00.000Z",
    "updatedAt": "2026-09-08T06:30:00.000Z"
  }
}
```

---

## 5. Update Organization Seats Capacity

Upgrades or scales down the licensed sales representative seat count for an organization.

### Endpoints:
- `PUT /api/organizations/:id/seats`

### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/seats \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "seats": 25
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Licensed seats updated to 25",
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "seats": 25,
    "usedSeats": 4,
    "remainingSeats": 21,
    "seatWarning": null
  }
}
```

---

## 6. Renew Organization Subscription

Renews or extends the subscription period. Automatically calculates duration based on `subscriptionPlan` (`monthly` &rarr; +1 mo, `quarterly` &rarr; +3 mos, `annually` &rarr; +12 mos) or custom `months` from current expiration date (or today if already expired).

### Endpoints:
- `PUT /api/organizations/:id/renew`

### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/renew \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "subscriptionPlan": "annually",
    "amountPaid": 59900,
    "paymentMethod": "UPI"
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Subscription successfully renewed (Annually plan) until 08/09/2027",
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "subscriptionPlan": "annually",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2027-09-08T23:59:59.999Z",
    "amountPaid": 65890,
    "status": "active",
    "paymentMethod": "UPI"
  }
}
```

---

## 7. Toggle Organization Status (Suspend / Activate)

Activates, suspends, or deactivates an organization. When an organization is suspended, logins, lead creation, and WhatsApp messaging are immediately locked for all tenant members.

### Endpoints:
- `PATCH /api/organizations/:id/status`

### cURL Request:

```bash
curl -X PATCH https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/status \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "status": "suspended"
  }'
```

*(Supported `status` values: `"active"`, `"inactive"`, `"suspended"`)*

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Organization status set to 'suspended'",
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "status": "suspended"
  }
}
```

---

## 8. Resend Welcome Email & Regenerate Credentials

Regenerates a new initial temporary password, updates both Master and Tenant databases, and resends the welcome onboarding email to the owner.

### Endpoints:
- `POST /api/organizations/:id/resend-welcome`

### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/resend-welcome \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Welcome email resent with new temporary credentials.",
  "emailSent": true,
  "credentials": {
    "email": "billing@acmetech.io",
    "temporaryPassword": "Acme#8d2e41a0@",
    "loginUrl": "https://crm.salesbuster.com/login"
  }
}
```

---

## 9. Update WhatsApp Connection Limit (`PUT /api/organizations/:id/whatsapp-limit`)

Configures the maximum number of WhatsApp connection lines for an organization tenant.

- `1` (or `"single"`): **Single Line (1 Device)**
- `2` (or `"double"` / `"dual"`): **Dual Lines (2 Devices)**

> [!NOTE]
> - **Downgrade Safety**: If downgrading an organization from `2` &rarr; `1` while Device 2 (`org_<orgId>_device_2`) is currently connected, the backend automatically logs out and terminates the secondary WhatsApp session.
> - **Real-time Synchronization**: The backend immediately emits an `organization_updated` socket event to the organization room (`org_<orgId>`).

### Endpoints:
- `PUT /api/organizations/:id/whatsapp-limit`

### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/whatsapp-limit \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "whatsappLineLimit": 2
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "WhatsApp line limit updated to 2 (Dual Lines) for organization \"Acme Technologies Inc.\".",
  "data": {
    "_id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "whatsappLineLimit": 2,
    "whatsappConnectionMode": "double",
    "seats": 10,
    "status": "active"
  }
}
```

---

## 10. Update Organization Add-ons (`PUT /api/organizations/:id/addons`)

Enables or disables modular organization add-ons:
- `whatsappCampaigns`: Unlocks Meta Cloud bulk messaging, campaign builder, template creation, and audience targeting.
- `biAnalyst`: Unlocks AI CRM Business Intelligence chat, data synthesis, and Gemini Multimodal Live Real-Time Voice session.

### Endpoints:
- `PUT /api/organizations/:id/addons`

### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/addons \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "whatsappCampaigns": true,
    "biAnalyst": true
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Add-ons updated successfully for organization \"Acme Technologies Inc.\".",
  "data": {
    "_id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "addons": {
      "whatsappCampaigns": true,
      "biAnalyst": true
    }
  }
}
```

---

## 11. Get Organization AI Settings (`GET /api/organizations/:id/ai-settings`)

Fetches the complete AI configuration, decrypted Google Gemini API key configuration status, persona prompts, business descriptions, product/service offerings, custom qualification fields, and Qdrant vector knowledge base documents for a specific tenant organization.

### Endpoints:
- `GET /api/organizations/:id/ai-settings`

### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/ai-settings \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "geminiApiKey": "AIzaSy...",
    "isGeminiKeyConfigured": true,
    "companyName": "Acme Technologies Inc.",
    "businessDescription": "Leading provider of SaaS solutions and enterprise CRM.",
    "agentPersona": "friendly, consultative, concise",
    "customInstructions": "Always ask if they would like a live video demo.",
    "services": [
      {
        "_id": "67a1b2c3d4e5f6a7b8c9d0e1",
        "name": "Cloud CRM Migration",
        "description": "Seamless transition from legacy CRM systems",
        "pricing": "$1,500 one-time",
        "imageUrl": "https://betaapi.salesbuster.ai/uploads/services/svc_1726501234.jpg"
      }
    ],
    "qualificationFields": [
      {
        "_id": "67a1b2c3d4e5f6a7b8c9d0e2",
        "field": "budget",
        "question": "What is your allocated budget for this project?",
        "type": "string",
        "required": true
      }
    ],
    "qdrantCollection": "org_66dd1f5e8b4e7a2b9c1d0001",
    "knowledgeDocs": [
      {
        "_id": "67a1b2c3d4e5f6a7b8c9d0e3",
        "originalName": "Acme_Company_Deck_2026.pdf",
        "fileSize": 1048576,
        "uploadedAt": "2026-09-10T12:00:00.000Z",
        "chunkCount": 24,
        "pointsCount": 24
      }
    ],
    "welcomeMessageTemplate": "Hi {name}! Welcome to Acme Technologies.",
    "welcomeMessageFallbackService": "Cloud CRM Migration",
    "missedCallMessageEnabled": true,
    "missedCallMessageTemplate": "Sorry we missed your call! A representative will call you right back.",
    "missedCallDifferentNumberTemplate": "Hello, we noticed a missed call on our corporate line.",
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
      },
      "lastResetAt": "2026-10-16T00:00:00.000Z"
    }
  }
}
```

---

## 12. Update Organization AI Settings (`PUT /api/organizations/:id/ai-settings`)

Updates the AI parameters for an organization, including custom Gemini API key encryption, assistant instructions, automated WhatsApp greeting templates, and missed call auto-replies.

### Endpoints:
- `PUT /api/organizations/:id/ai-settings`

### cURL Request:

```bash
curl -X PUT https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/ai-settings \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "geminiApiKey": "AIzaSyNewCustomGeminiKey1234567890",
    "companyName": "Acme Technologies Inc.",
    "businessDescription": "Leading provider of SaaS solutions and enterprise CRM.",
    "agentPersona": "friendly, consultative, concise",
    "customInstructions": "Always ask if they would like a live video demo.",
    "welcomeMessageTemplate": "Hi {name}! Welcome to Acme Technologies.",
    "welcomeMessageFallbackService": "Cloud CRM Migration",
    "missedCallMessageEnabled": true,
    "missedCallMessageTemplate": "Sorry we missed your call! A representative will call you right back.",
    "serviceImagesAutoSendEnabled": true,
    "dailyQuotaLimit": 500
  }'
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Organization AI settings updated successfully.",
  "data": {
    "companyName": "Acme Technologies Inc.",
    "businessDescription": "Leading provider of SaaS solutions and enterprise CRM.",
    "agentPersona": "friendly, consultative, concise",
    "customInstructions": "Always ask if they would like a live video demo.",
    "welcomeMessageTemplate": "Hi {name}! Welcome to Acme Technologies.",
    "welcomeMessageFallbackService": "Cloud CRM Migration",
    "missedCallMessageEnabled": true,
    "missedCallMessageTemplate": "Sorry we missed your call! A representative will call you right back.",
    "serviceImagesAutoSendEnabled": true,
    "dailyQuotaLimit": 500
  }
}
```

---

## 13. Upload Organization Knowledge Document (`POST /api/organizations/:id/knowledge-base/upload`)

Uploads a document (PDF, DOCX, TXT, MD) on behalf of an organization, parses text, generates semantic embeddings via Google Gemini embeddings, and indexes points directly into the tenant's isolated Qdrant vector collection (`org_<orgId>`).

### Endpoints:
- `POST /api/organizations/:id/knowledge-base/upload`

### Headers:
- `Content-Type: multipart/form-data`
- `x-admin-key: salesbuster_super_admin_secret_key_2026` OR `Authorization: Bearer <SUPER_ADMIN_JWT>`

### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/knowledge-base/upload \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -F "file=@/path/to/Acme_Product_Manual_2026.pdf"
```

### Success Response (`201 Created`):

```json
{
  "success": true,
  "message": "Document 'Acme_Product_Manual_2026.pdf' indexed successfully into Qdrant.",
  "data": {
    "_id": "6701b2c3d4e5f6a7b8c9d0f4",
    "originalName": "Acme_Product_Manual_2026.pdf",
    "fileSize": 2048500,
    "uploadedAt": "2026-10-16T13:00:00.000Z",
    "chunkCount": 35,
    "pointsCount": 35
  }
}
```

---

## 14. Delete Organization Knowledge Document (`DELETE /api/organizations/:id/knowledge-base/:docId`)

Purges all embedded vector points associated with a specific document from the organization's Qdrant collection and removes the file record from MongoDB.

### Endpoints:
- `DELETE /api/organizations/:id/knowledge-base/:docId`

### cURL Request:

```bash
curl -X DELETE https://betaapi.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/knowledge-base/6701b2c3d4e5f6a7b8c9d0f4 \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "Document removed from knowledge base.",
  "docId": "6701b2c3d4e5f6a7b8c9d0f4"
}
```

---

## 15. Split Daily 500 Conversation Quota (`PUT /api/organizations/my-org/quota-split`)

Allows Sales Managers, Organization Owners, or Super Admins to partition an organization's fixed daily quota of **500 conversations/day** across the 3 AI channels:
1. **`whatsappAi`**: Automated WhatsApp chatbot lead qualification replies.
2. **`calls`**: Call recording audio transcriptions and sentiment analyses.
3. **`biAnalyst`**: CRM business intelligence queries and Gemini Live real-time voice sessions. *(Requires active `biAnalyst` add-on)*.

> [!IMPORTANT]
> - Sum of `whatsappAi + calls + biAnalyst` cannot exceed **500**.
> - Allocating `biAnalyst > 0` returns `400 Bad Request` if the organization does not have the `biAnalyst` add-on enabled.
> - Updates are broadcast live over Socket.IO to connected client interfaces.

### Endpoints:
- `PUT /api/organizations/my-org/quota-split`

### Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <MANAGER_OR_OWNER_OR_SUPER_ADMIN_JWT>`

### cURL Request:

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

### Success Response (`200 OK`):

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

## 16. Tenant Owner Profile API (`GET /api/organizations/my-org`)

Used by the Tenant CRM frontend (`/organization` page) to fetch live metrics, subscription dates, seat capacity, active add-ons, and daily quota utilization for the authenticated Organization Owner or Sales Manager.

### Endpoints:
- `GET /api/organizations/my-org`

### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/organizations/my-org \
  -H "Authorization: Bearer <ORGANIZATION_OWNER_JWT_TOKEN>"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "email": "billing@acmetech.io",
    "mobile": "+91 98765 43210",
    "website": "https://acmetech.io",
    "seats": 10,
    "usedSeats": 4,
    "remainingSeats": 6,
    "amountPaid": 5990,
    "pricingPerSeat": 599,
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2026-12-08T23:59:59.999Z",
    "status": "active",
    "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
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
    "totalLeads": 42,
    "totalFollowups": 18,
    "isExpired": false,
    "remainingDays": 53
  }
}
```

---

## 17. Upload Mobile App APK (`POST /api/app-release/upload`)

Uploads a new Android application package (`.apk`). **Every time a new APK is uploaded, the backend automatically deletes the previous APK file from disk to conserve storage, purges obsolete database records, and stores the new release.**

### Endpoints:
- `POST /api/app-release/upload` (Recommended)
- `POST /api/mobile-app/apk/upload` (Alias)

### Form-Data Parameters:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` (or `apk`) | Binary File | **Yes** | Android `.apk` binary file (up to 200 MB). |
| `version` | String | No | Semantic version string (e.g. `"1.0.4"`). Defaults to `"1.0.0"`. |
| `versionCode` | Number | No | Android numeric build code (e.g. `4`). Defaults to `1`. |
| `minSupportedVersion` | String | No | Minimum compatible version (e.g. `"1.0.0"`). |
| `releaseNotes` | String | No | Change log, bug fixes, or new features. |

### cURL Request:

```bash
curl -X POST https://betaapi.salesbuster.ai/api/app-release/upload \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -F "file=@/path/to/app-release.apk" \
  -F "version=1.0.4" \
  -F "versionCode=4" \
  -F "minSupportedVersion=1.0.0" \
  -F "releaseNotes=Added background call recording, real-time lead sync, and quota split monitor."
```

### Success Response (`201 Created`):

```json
{
  "success": true,
  "message": "New APK (version 1.0.4) uploaded successfully. Previous APK has been replaced.",
  "data": {
    "_id": "6701a2b3c4d5e6f7a8b9c0d1",
    "version": "1.0.4",
    "versionCode": 4,
    "minSupportedVersion": "1.0.0",
    "releaseNotes": "Added background call recording, real-time lead sync, and quota split monitor.",
    "originalName": "app-release.apk",
    "fileName": "1726501234567-app_release.apk",
    "fileSize": 45218900,
    "fileSizeFormatted": "43.12 MB",
    "downloadUrl": "https://betaapi.salesbuster.ai/api/mobile-app/apk/download",
    "fileUrl": "https://betaapi.salesbuster.ai/uploads/apk/1726501234567-app_release.apk",
    "uploadedByName": "Super Admin",
    "uploadedAt": "2026-10-16T13:00:00.000Z"
  }
}
```

---

## 18. Check Current Uploaded APK Info (`GET /api/app-release/latest`)

Returns the active release metadata for administrative dashboards or mobile in-app update checks:

### Endpoints:
- `GET /api/app-release/latest`

### cURL Request:

```bash
curl -X GET https://betaapi.salesbuster.ai/api/app-release/latest
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "data": {
    "_id": "6701a2b3c4d5e6f7a8b9c0d1",
    "version": "1.0.4",
    "versionCode": 4,
    "minSupportedVersion": "1.0.0",
    "releaseNotes": "Added background call recording, real-time lead sync, and quota split monitor.",
    "fileSize": 45218900,
    "fileSizeFormatted": "43.12 MB",
    "downloadUrl": "https://betaapi.salesbuster.ai/api/mobile-app/apk/download",
    "uploadedAt": "2026-10-16T13:00:00.000Z"
  }
}
```

---

## 19. Direct Download Endpoint for Android Devices (`GET /api/mobile-app/apk/download`)

Triggers an immediate binary file download of the `.apk` on Android phones/browsers with MIME type `application/vnd.android.package-archive`:

### Endpoints:
- `GET /api/mobile-app/apk/download`
- `GET /api/app-release/download`

### cURL Request:

```bash
curl -O -J https://betaapi.salesbuster.ai/api/mobile-app/apk/download
```

---

## 20. Delete Active APK (`DELETE /api/app-release`)

Removes the current APK binary file from disk and clears the release record in the database:

### Endpoints:
- `DELETE /api/app-release`

### cURL Request:

```bash
curl -X DELETE https://betaapi.salesbuster.ai/api/app-release \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026"
```

### Success Response (`200 OK`):

```json
{
  "success": true,
  "message": "APK release deleted successfully from server disk and database."
}
```

---

## Error Handling Reference & Status Codes

| Status Code | Description | Example Response Body |
|---|---|---|
| `400 Bad Request` | Validation failure (e.g., quota > 500, non-apk file upload, invalid plan). | `{"success": false, "message": "Total allocated quota cannot exceed 500."}` |
| `401 Unauthorized` | Missing or expired Bearer token, or invalid `x-admin-key`. | `{"success": false, "message": "Not authorized, token failed"}` |
| `403 Forbidden` | Super Admin privileges required or inactive add-on requested. | `{"success": false, "message": "Cannot allocate quota to BI Analyst because the add-on is not active for this organization."}` |
| `404 Not Found` | Target organization, document ID, or APK release does not exist. | `{"success": false, "message": "Organization not found"}` |
| `429 Too Many Requests` | Daily AI conversation quota exhausted for channel or total 500 limit. | `{"success": false, "message": "Daily quota limit for WhatsApp AI Chat Bot reached (250/250). Resets at 00:00 UTC.", "quotaExceeded": true}` |
| `500 Server Error` | Database connection error or unhandled exception. | `{"success": false, "message": "Server error while processing request"}` |
