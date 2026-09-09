# Organization Provisioning API Documentation

This document provides ready-to-run **cURL commands** (both Bash and Windows PowerShell) and exact **JSON responses** for creating/provisioning tenant organizations with **Quarterly** and **Annually** subscription plans.

---

## Base URLs & Endpoints

| Environment | Base URL |
| :--- | :--- |
| **Local Development** | `http://localhost:5000/api` |
| **Production** | `https://api.salesbuster.ai/api` |

### API Endpoints
- `POST /api/organizations/provision` *(Recommended / Explicit)*
- `POST /api/organizations` *(Standard REST)*

---

## Authentication Methods

Super Admin endpoints require administrative credentials. Provide either of the following in request headers:

### Option A: Super Admin Bearer JWT Token (Recommended)
```http
Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>
```
*(Obtain this token by logging in via `POST /api/auth/login` with your Super Admin account).*

### Option B: Super Admin API Key (Backend-to-Backend)
```http
x-admin-key: salesbuster_super_admin_secret_key_2026
```
*(Configurable via `ADMIN_API_KEY` in the backend `.env`).*

---

## 1. Quarterly Plan (3 Months Validity)

- **Subscription Duration**: 3 calendar months (e.g., `2026-09-09` &rarr; `2026-12-09T23:59:59.999Z`)
- **Field Value**: `"subscriptionPlan": "quarterly"`

### cURL (Bash / Linux / macOS)
```bash
curl -X POST "https://api.salesbuster.ai/api/organizations/provision" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>" \
  -d '{
    "name": "Apex Innovations Ltd",
    "email": "billing@apexinnovations.io",
    "mobile": "+91 9876543210",
    "website": "https://apexinnovations.io",
    "seats": 5,
    "amountPaid": 4500,
    "pricingPerSeat": 900,
    "paymentMethod": "UPI",
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
    "notes": "Growth tier - quarterly billing cycle"
  }'
```

### cURL using `x-admin-key`
```bash
curl -X POST "https://api.salesbuster.ai/api/organizations/provision" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "name": "Apex Innovations Ltd",
    "email": "billing@apexinnovations.io",
    "mobile": "+91 9876543210",
    "website": "https://apexinnovations.io",
    "seats": 5,
    "amountPaid": 4500,
    "pricingPerSeat": 900,
    "paymentMethod": "UPI",
    "subscriptionPlan": "quarterly",
    "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
    "notes": "Growth tier - quarterly billing cycle"
  }'
```

### Windows PowerShell
```powershell
$headers = @{
    "Content-Type"  = "application/json"
    "Authorization" = "Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>"
}

$body = @{
    name                  = "Apex Innovations Ltd"
    email                 = "billing@apexinnovations.io"
    mobile                = "+91 9876543210"
    website               = "https://apexinnovations.io"
    seats                 = 5
    amountPaid            = 4500
    pricingPerSeat        = 900
    paymentMethod         = "UPI"
    subscriptionPlan      = "quarterly"
    subscriptionStartDate = "2026-09-09T00:00:00.000Z"
    notes                 = "Growth tier - quarterly billing cycle"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://api.salesbuster.ai/api/organizations/provision" -Method Post -Headers $headers -Body $body
```

### Success Response (`201 Created`)
```json
{
  "success": true,
  "message": "Tenant organization provisioned successfully. Welcome email with credentials dispatched.",
  "data": {
    "organization": {
      "id": "66dee4a1b2c3d4e5f6a7b801",
      "name": "Apex Innovations Ltd",
      "email": "billing@apexinnovations.io",
      "mobile": "+91 9876543210",
      "website": "https://apexinnovations.io",
      "seats": 5,
      "amountPaid": 4500,
      "pricingPerSeat": 900,
      "subscriptionPlan": "quarterly",
      "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
      "subscriptionEndDate": "2026-12-09T23:59:59.999Z",
      "status": "active",
      "tenantDbName": "sb_tenant_apex_innovations_a3f81e",
      "createdBy": "66dd0a1b2c3d4e5f6a7b8c90"
    },
    "emailSent": true,
    "credentials": {
      "email": "billing@apexinnovations.io",
      "temporaryPassword": "Apex#7b129cd4@",
      "loginUrl": "https://crm.salesbuster.com/login"
    }
  }
}
```

---

## 2. Annually Plan (12 Months Validity)

- **Subscription Duration**: 12 calendar months (e.g., `2026-09-09` &rarr; `2027-09-09T23:59:59.999Z`)
- **Field Value**: `"subscriptionPlan": "annually"` *(or `"annual"`)*

### cURL (Bash / Linux / macOS)
```bash
curl -X POST "https://api.salesbuster.ai/api/organizations/provision" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>" \
  -d '{
    "name": "Nexora Global Corp",
    "email": "admin@nexoraglobal.com",
    "mobile": "+91 9123456780",
    "website": "https://nexoraglobal.com",
    "seats": 15,
    "amountPaid": 16200,
    "pricingPerSeat": 1080,
    "paymentMethod": "Bank Transfer",
    "subscriptionPlan": "annually",
    "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
    "notes": "Enterprise Tier - 12 month prepayment"
  }'
```

### cURL using `x-admin-key`
```bash
curl -X POST "https://api.salesbuster.ai/api/organizations/provision" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: salesbuster_super_admin_secret_key_2026" \
  -d '{
    "name": "Nexora Global Corp",
    "email": "admin@nexoraglobal.com",
    "mobile": "+91 9123456780",
    "website": "https://nexoraglobal.com",
    "seats": 15,
    "amountPaid": 16200,
    "pricingPerSeat": 1080,
    "paymentMethod": "Bank Transfer",
    "subscriptionPlan": "annually",
    "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
    "notes": "Enterprise Tier - 12 month prepayment"
  }'
```

### Windows PowerShell
```powershell
$headers = @{
    "Content-Type"  = "application/json"
    "Authorization" = "Bearer <YOUR_SUPER_ADMIN_JWT_TOKEN>"
}

$body = @{
    name                  = "Nexora Global Corp"
    email                 = "admin@nexoraglobal.com"
    mobile                = "+91 9123456780"
    website               = "https://nexoraglobal.com"
    seats                 = 15
    amountPaid            = 16200
    pricingPerSeat        = 1080
    paymentMethod         = "Bank Transfer"
    subscriptionPlan      = "annually"
    subscriptionStartDate = "2026-09-09T00:00:00.000Z"
    notes                 = "Enterprise Tier - 12 month prepayment"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://api.salesbuster.ai/api/organizations/provision" -Method Post -Headers $headers -Body $body
```

### Success Response (`201 Created`)
```json
{
  "success": true,
  "message": "Tenant organization provisioned successfully. Welcome email with credentials dispatched.",
  "data": {
    "organization": {
      "id": "66dee4b9b2c3d4e5f6a7b802",
      "name": "Nexora Global Corp",
      "email": "admin@nexoraglobal.com",
      "mobile": "+91 9123456780",
      "website": "https://nexoraglobal.com",
      "seats": 15,
      "amountPaid": 16200,
      "pricingPerSeat": 1080,
      "subscriptionPlan": "annually",
      "subscriptionStartDate": "2026-09-09T00:00:00.000Z",
      "subscriptionEndDate": "2027-09-09T23:59:59.999Z",
      "status": "active",
      "tenantDbName": "sb_tenant_nexora_global_f48a20",
      "createdBy": "66dd0a1b2c3d4e5f6a7b8c90"
    },
    "emailSent": true,
    "credentials": {
      "email": "admin@nexoraglobal.com",
      "temporaryPassword": "Nexora#4e98f021@",
      "loginUrl": "https://crm.salesbuster.com/login"
    }
  }
}
```

---

## Request Body Field Specifications

| Field | Type | Required | Default | Description |
| :--- | :--- | :---: | :--- | :--- |
| `name` | `string` | **Yes** | — | Organization / Company name. |
| `email` | `string` | **Yes** | — | Billing and owner email address. Must be unique. |
| `mobile` | `string` | **Yes** | — | Primary contact mobile number. |
| `seats` | `number` | **Yes** | — | Number of user seats allocated (must be an integer &ge; 1). |
| `amountPaid` | `number` | **Yes** | — | Total payment received (must be &ge; 0). |
| `subscriptionPlan` | `string` | **Yes** | `"monthly"` | Subscription billing cycle: `"quarterly"`, `"annually"` (or `"monthly"`). |
| `pricingPerSeat` | `number` | No | `amountPaid / seats` | Unit price per seat. Automatically calculated if omitted. |
| `paymentMethod` | `string` | No | `"Manual"` | Mode of payment (e.g. `"UPI"`, `"Bank Transfer"`, `"Stripe"`, `"Cash"`). |
| `subscriptionStartDate` | `string` | No | Current timestamp | ISO 8601 start date (e.g. `"2026-09-09T00:00:00.000Z"`). |
| `website` | `string` | No | `""` | Company website URL. |
| `notes` | `string` | No | `""` | Internal notes or comments regarding the account. |

---

## Backend Automated Actions

Upon executing the provision API, the backend automatically performs the following:

1. **Calculates Validity Period**:
   - For `quarterly`: Adds **3 months** to the start date and sets expiry to `23:59:59.999`.
   - For `annually`: Adds **12 months** to the start date and sets expiry to `23:59:59.999`.
2. **Generates Tenant Database**:
   - Generates an isolated MongoDB database named `sb_tenant_<slug>_<unique_hex>` for tenant data isolation.
3. **Generates Secure Credentials**:
   - Generates a cryptographically randomized temporary password for the tenant owner.
4. **Creates Master & Tenant User Accounts**:
   - Creates the tenant owner record in the Master `AuthUser` collection and initializes the owner inside the tenant's own database as `sales manager`.
5. **Sends Onboarding Email**:
   - Dispatches a branded welcome email to the owner containing their login URL and temporary password.

---

## Error Responses

### 1. Missing Required Fields (`400 Bad Request`)
```json
{
  "success": false,
  "message": "Missing required fields: name, email, mobile, seats, and amountPaid are required."
}
```

### 2. Email Already Exists (`400 Bad Request`)
```json
{
  "success": false,
  "message": "An account with email 'billing@apexinnovations.io' already exists."
}
```

### 3. Invalid Subscription Plan (`400 Bad Request`)
```json
{
  "success": false,
  "message": "Invalid subscriptionPlan 'bi-annual'. Allowed values: monthly, quarterly, annually."
}
```

### 4. Unauthorized / Invalid Token (`401 Unauthorized`)
```json
{
  "success": false,
  "message": "Not authorized, token failed"
}
```

### 5. Non-Admin Access (`403 Forbidden`)
```json
{
  "success": false,
  "message": "Access forbidden: Super Administrator privileges required"
}
```
