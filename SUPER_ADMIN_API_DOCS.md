# SalesBuster CRM — Super Admin REST API Documentation

This document provides ready-to-use **cURL commands**, request payloads, headers, and sample JSON responses for all Super Admin endpoints. These APIs are designed for your **separate Admin project** to provision organizations, manage seat allocations, renew subscriptions, and control tenant access.

---

## Base URLs & Authentication

- **Production Base URL**: `https://api.salesbuster.ai/api`
- **Local Dev Base URL**: `http://localhost:5000/api`

### Authentication Methods
Super Admin endpoints support either of the following authentication methods:

1. **Admin Secret API Key (Recommended for Admin Service / Backend-to-Backend)**:
   - Header: `x-admin-key: salesbuster_super_admin_secret_key_2026`
   *(Configurable via `ADMIN_API_KEY` in backend `.env`)*

2. **Bearer JWT Token (For logged-in Super Admin users)**:
   - Header: `Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>`

---

## 1. Super Admin Authentication & Login

Logs in the Super Administrator and returns a Bearer JWT Token with `role: "super_admin"`. This token can be used in the `Authorization: Bearer <TOKEN>` header for all subsequent administrative endpoints.

### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@gmail",
    "password": "123456"
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

> [!TIP]
> Copy the returned `token` string and use it in your Admin Project header:
> `Authorization: Bearer eyJhbGci...`

---

## 2. Provision New Organization Tenant

Creates an isolated client tenant, initializes their private database (`sb_tenant_<slug>_<id>`), auto-generates a secure password, calculates monthly subscription validity (e.g. Sep 8 → Oct 8), and dispatches the welcome onboarding email.

> [!NOTE]
> **No Password Required**: Do **not** send a password in the request. The backend auto-generates a complex password and emails it to the owner.

### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/organizations/provision \
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
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "notes": "Enterprise Tier client"
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
      "subscriptionPlan": "monthly",
      "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
      "subscriptionEndDate": "2026-10-08T23:59:59.999Z",
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

## 2. Get All Organizations (With Live Seat Metrics)

Returns a list of all client organizations with live seat utilization (`usedSeats / totalSeats`), remaining available seats, and subscription expiry flags.

### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/organizations \
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
      "subscriptionPlan": "monthly",
      "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
      "subscriptionEndDate": "2026-10-08T23:59:59.999Z",
      "status": "active",
      "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
      "isExpired": false,
      "createdAt": "2026-09-08T06:30:00.000Z"
    },
    {
      "id": "66dd2a1c8b4e7a2b9c1d0002",
      "name": "Skyline Logistics",
      "email": "contact@skylinelog.com",
      "mobile": "+91 91234 56789",
      "website": "https://skylinelog.com",
      "seats": 5,
      "usedSeats": 5,
      "remainingSeats": 0,
      "amountPaid": 2995,
      "pricingPerSeat": 599,
      "subscriptionPlan": "monthly",
      "subscriptionStartDate": "2026-08-01T00:00:00.000Z",
      "subscriptionEndDate": "2026-09-01T23:59:59.999Z",
      "status": "active",
      "tenantDbName": "sb_tenant_skyline_logistics_a1b2c3",
      "isExpired": true,
      "createdAt": "2026-08-01T05:15:00.000Z"
    }
  ]
}
```

---

## 3. Get Single Organization Details

Fetches deep metrics for a single organization by its ID.

### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001 \
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
    "subscriptionPlan": "monthly",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2026-10-08T23:59:59.999Z",
    "status": "active",
    "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
    "ownerId": "66dd1f5e8b4e7a2b9c1d0000",
    "isExpired": false,
    "createdAt": "2026-09-08T06:30:00.000Z",
    "updatedAt": "2026-09-08T06:30:00.000Z"
  }
}
```

---

## 4. Update Organization Seats Capacity

Upgrades or scales down the licensed sales representative seat count for an organization.

### cURL Request:
```bash
curl -X PUT https://api.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/seats \
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

## 5. Renew Organization Subscription

Renews or extends the monthly subscription period. Automatically calculates +1 calendar month (or specified `months`) from current expiration date or today.

### cURL Request:
```bash
curl -X PUT https://api.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/renew \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "months": 1,
    "amountPaid": 5990,
    "paymentMethod": "UPI"
  }'
```

### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Subscription successfully renewed until 08/11/2026",
  "data": {
    "id": "66dd1f5e8b4e7a2b9c1d0001",
    "name": "Acme Technologies Inc.",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2026-11-08T23:59:59.999Z",
    "amountPaid": 11980,
    "status": "active",
    "paymentMethod": "UPI"
  }
}
```

---

## 6. Toggle Organization Status (Suspend / Activate)

Activates, suspends, or deactivates an organization. When an organization is suspended, logins and lead creation are immediately locked for all its members.

### cURL Request:
```bash
curl -X PATCH https://api.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/status \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "status": "suspended"
  }'
```

*(Options for `status`: `"active"`, `"inactive"`, `"suspended"`)*

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

## 7. Resend Welcome Email & Regenerate Credentials

Regenerates a new initial temporary password, updates both Master and Tenant databases, and resends the welcome onboarding email to the owner.

### cURL Request:
```bash
curl -X POST https://api.salesbuster.ai/api/organizations/66dd1f5e8b4e7a2b9c1d0001/resend-welcome \
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

## 8. Tenant Owner Profile API (`GET /api/organizations/my-org`)

Used by the Tenant CRM frontend (`/organization` page) to fetch live metrics and details for the logged-in Organization Owner.

### cURL Request:
```bash
curl -X GET https://api.salesbuster.ai/api/organizations/my-org \
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
    "subscriptionPlan": "monthly",
    "subscriptionStartDate": "2026-09-08T00:00:00.000Z",
    "subscriptionEndDate": "2026-10-08T23:59:59.999Z",
    "status": "active",
    "tenantDbName": "sb_tenant_acme_technologies_7cfcaa",
    "totalLeads": 42,
    "totalFollowups": 18,
    "isExpired": false,
    "remainingDays": 30
  }
}
```

---

## Error Handling Reference

| Status Code | Description | Example Response |
|---|---|---|
| `400 Bad Request` | Missing required fields or duplicate email | `{"success": false, "message": "An account with email 'billing@acmetech.io' already exists."}` |
| `401 Unauthorized` | Missing or invalid auth token/key | `{"success": false, "message": "Not authorized, token failed"}` |
| `403 Forbidden` | Super Admin privileges required or limit reached | `{"success": false, "message": "Access forbidden: Super Administrator privileges required"}` |
| `404 Not Found` | Organization not found | `{"success": false, "message": "Organization not found"}` |
| `500 Server Error`| Internal error during provisioning/database switch | `{"success": false, "message": "Server error while provisioning organization"}` |
