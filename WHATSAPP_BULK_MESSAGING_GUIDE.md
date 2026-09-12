# WhatsApp Bulk Messaging & Cloud API — Complete Guide

Welcome to the **SalesBuster CRM WhatsApp Cloud API & Bulk Messaging** system. This guide explains how the official Meta WhatsApp Business Cloud API integration works, how to import leads from Excel into **Old Leads**, and how to launch compliant bulk broadcast campaigns.

---

## 1. System Architecture Overview

SalesBuster CRM features a dual-layer WhatsApp communication engine:

1. **Official Meta WhatsApp Cloud API** (Broadcasts & Campaigns):
   * Designed for high-volume marketing broadcasts, transactional alerts, and utility notifications.
   * Connects via official Meta Graph API (`v26.0`) with approved templates.
   * Multi-tenant: Each organization securely connects its own WhatsApp Business Account (WABA).
   * Credentials (System User Access Tokens) are encrypted at rest using hardware **AES-256-GCM**.
2. **Baileys Web/QR WhatsApp** (Direct 1-on-1 Chats):
   * Designed for direct sales conversations via phone QR pairing in the **WhatsApp Chat** tab.

---

## 2. Setting Up WhatsApp Cloud API (Per Organization)

Each organization admin can connect their official Meta account in seconds:

1. Open **WhatsApp Campaigns** (`/whatsapp/campaigns`) or **Templates** (`/whatsapp/templates`).
2. Click **Cloud API Settings** (or the connection status pill in the top header).
3. Fill in the three Meta credentials:
   * **WABA ID** (WhatsApp Business Account ID): Found in Meta Developer Dashboard &rarr; WhatsApp &rarr; API Setup.
   * **Phone Number ID**: Found in Meta Developer Dashboard &rarr; WhatsApp &rarr; API Setup.
   * **Meta System User Access Token**: Permanent `EAAG...` token generated in Meta Business Manager with permissions:
     * `whatsapp_business_messaging`
     * `whatsapp_business_management`
4. The **Sending Rate Limit** is locked to **`5 msg/s` (Default)** to maintain top-tier Meta quality ratings and prevent accidental rate limit penalties.
5. Click **Save & Verify**. The system validates your credentials against Meta's Graph API, displays your verified phone number, approved display name, quality rating (`GREEN`, `YELLOW`), and messaging tier limit (`TIER_1K`, `TIER_10K`, etc.).

---

## 3. Importing Leads from Excel into "Old Leads"

You can bulk import contacts from Microsoft Excel (`.xlsx`, `.xls`) or CSV (`.csv`) directly into **Old Leads** to prepare them for broadcast campaigns.

### Step-by-Step Import:
1. Go to the **Leads** page (`/leads`).
2. In the top right header, click **Import Excel** (next to *+ Add New Lead*).
3. Drag & drop your Excel/CSV file or click to browse.
   * *(Optional)* Click **Download Sample Excel Template** to get an example spreadsheet with recommended column headers.
4. **Column Auto-Detection & Mapping**:
   * The system automatically scans your spreadsheet headers and maps them:
     * **Full Name** &rarr; `Name`, `Full Name`, `Customer Name`
     * **Phone / WhatsApp** *(Required)* &rarr; `Phone`, `Mobile`, `Contact Number`
     * **Email Address** &rarr; `Email`, `Mail`
     * **Service / Product** &rarr; `Service`, `Product` (fallback: *General Enquiry*)
     * **City** &rarr; `City`, `Location`
     * **Company** &rarr; `Company`, `Organization`
     * **Notes** &rarr; `Notes`, `Remarks`
5. **Review Preview & Options**:
   * Inspect the first 3 rows in the live preview table (with green dots indicating valid 10+ digit numbers).
   * Specify a **Batch Identifier Tag** (e.g. `Excel-March-2026`).
   * Select telecaller assignment (or choose *Unassigned (Round-Robin Auto Assign)*).
   * Keep **"Skip duplicate leads if phone number already exists in CRM"** checked to prevent re-importing existing contacts.
6. Click **Import Leads to Old Leads**.
7. **Automatic Classification**:
   * All imported contacts are automatically flagged with `isOldLead: true`, `status: "New"`, and `hasWhatsAppConsent: true`.
   * The page automatically redirects you to the **Old Leads** tab (`/leads/oldleads`) where you can immediately see and manage your newly imported contacts.

---

## 4. Syncing WhatsApp Templates from Meta

To comply with Meta guidelines, all outbound marketing broadcasts must use pre-approved Meta message templates.

1. Navigate to **WhatsApp Campaigns** &rarr; **Templates** (`/whatsapp/templates`).
2. Click **Sync Templates**.
3. SalesBuster CRM pulls all your approved templates from Meta WABA and parses:
   * Header format (`TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT`).
   * Body copy with dynamic variable placeholders (`{{1}}`, `{{2}}`, etc.).
   * Interactive buttons (Quick Reply, Call-to-Action URLs, Phone numbers).
4. Click **Use in Campaign** directly on any template card to launch a campaign with that template preselected.

---

## 5. Creating & Launching a Bulk Broadcast Campaign

1. Navigate to **WhatsApp Campaigns** (`/whatsapp/campaigns`) and click **+ New Campaign**.
2. Complete the 5-step wizard:

### Step 1: Campaign Info
* Give your broadcast an identifiable title (e.g. *"March Special Product Offer"*).

### Step 2: Target Audience Selection
* **Audience Lead Segment**:
  * **All Leads (Full Database)**: Target all qualified contacts across the CRM.
  * **Old Leads Only (Excel Imports)**: Target only the contacts you imported via Excel.
  * **New Leads Only**: Target newly created organic leads.
* **Filter by Lead Status**: Select statuses like `New`, `Follow Up`, `Not Attended`.
* **Filter by Service / Product**: Target specific services.
* **Automatic Audience Protection**:
  * Excludes invalid phone numbers (`< 10 digits`).
  * Excludes numbers on the **WhatsApp Opt-Out list** (contacts who texted `STOP`).
  * Excludes leads without opt-in consent when *"Require Explicit WhatsApp Consent"* is checked.
  * Real-time recipient counter displays the exact count of eligible leads.

### Step 3: Select Template
* Choose your approved template from your synced Meta catalog.

### Step 4: Variable Mapping & Live Preview
* Map each dynamic placeholder in the template:
  * `{{1}}` &rarr; Lead Name (`name`) with fallback *"Valued Customer"*.
  * `{{2}}` &rarr; Lead Service (`service`).
  * `{{3}}` &rarr; Lead City (`city`).
* **Header Media**: If the template accepts an image or PDF document, provide the public media URL.
* **Real-Time WhatsApp Preview**: Watch the simulated WhatsApp chat preview render your interpolated values dynamically as you type.

### Step 5: Review & Launch
* Set your throughput speed (e.g. `5 messages/second`).
* Choose **Save as Draft** or click **Launch Now**.

---

## 6. Real-Time Execution, Queue Engine & Delivery Tracking

Once a campaign is launched, the SalesBuster background queue engine handles execution:

* **Crash-Resilient Worker**:
  * Uses atomic database leasing (`findOneAndUpdate` with `lockedAt` and 2-minute stale lock recovery) to guarantee zero duplicate sends, even across server restarts.
* **Meta Rate Limit Protection**:
  * Automatically detects Meta throttling errors (`130429`, `80007`) and pauses with exponential backoff before resuming.
* **Quality Rating Tripwire**:
  * If Meta's daily tier limit or quality block (`131049`) is triggered, the worker immediately pauses the campaign automatically to protect your phone number from suspension.
* **Live Socket.IO Progress**:
  * The campaign dashboard updates live progress bars without page refreshing.
* **Control Actions**:
  * **Pause**: Temporarily suspend sending.
  * **Resume**: Continue from the exact point paused.
  * **Cancel**: Stop the campaign and cancel remaining queued messages.
  * **Retry Failed**: Re-queue contacts that encountered temporary network errors.

---

## 7. Webhook Configuration, Billing & Inbound AI Auto-Reply

### A. Configuring the Meta Webhook (Step-by-Step)
To receive message delivery receipts (Sent, Delivered, Read), customer replies, and opt-outs, configure your webhook in the Meta App Dashboard:

1. Go to [developers.facebook.com](https://developers.facebook.com) &rarr; Select your App.
2. In the left sidebar, expand **WhatsApp** &rarr; click **Configuration**.
3. Under **Webhook**, click **Edit**:
   * **Callback URL**:
     ```text
     https://api.salesbuster.ai/api/whatsapp/cloud/webhook
     ```
     *(Or per-organization URL: `https://api.salesbuster.ai/api/whatsapp/cloud/webhook/<orgId>`)*
   * **Verify Token**:
     ```text
     salesbuster_whatsapp_cloud_verify_token_2026
     ```
     *(Or the value set in your backend `.env` under `WHATSAPP_CLOUD_VERIFY_TOKEN`)*
4. Click **Verify and Save**.
5. Click **Manage Webhook Fields** and subscribe to:
   * `messages` *(Required: delivers incoming customer replies, text, images, quick-reply clicks, and delivery receipts)*

---

### B. Meta Billing & Conversation Charges: How Does It Work?

Meta charges based on **24-hour Conversations**, NOT per individual message:

1. **When You Send Bulk Marketing Messages**:
   * Meta charges for 1 **Marketing Conversation** per recipient when the template is delivered (approx ₹0.78 to ₹0.88 INR in India, or ~$0.025 USD in the US).
   * This payment unlocks a **24-hour conversation window** with that recipient.
2. **When the Customer Replies (Are Any Extra Charges Applied?)**:
   * **NO extra charge is applied** when the customer replies!
   * The customer's reply falls directly inside the already active 24-hour conversation window.
   * Both you and your AI representative can send **unlimited free-form conversational messages back and forth** within that 24-hour window at **zero additional Meta messaging cost**.
   * Meta also provides **1,000 free Service conversations per month** to every WhatsApp Business Account (WABA).

---

### C. AI Auto-Reply to Customer Responses
* **Does AI auto-reply?** **YES.**
* When a customer replies to your broadcast message:
  1. The webhook verifies that the 24-hour customer service window is open.
  2. If the lead has AI enabled (`lead.aiEnabled: true`) and your organization has Gemini AI configured (`aiSettings.geminiApiKey`), the integrated **Gemini AI Representative** analyzes the customer's text and context.
  3. The AI drafts a natural, professional response and sends it automatically via the official Meta Cloud API.
  4. **Human Takeover Protection**: If a human sales rep manually types and sends a reply from the CRM, AI is automatically paused for 5 minutes so the human has complete control.

---

### D. Will Inbound Messages Appear in the WhatsApp Chat Page?
* **YES, 100%.**
* Every inbound customer message and every outbound AI reply is automatically saved to the tenant's `Message` and `Conversation` collections in MongoDB.
* The system broadcasts real-time Socket.IO events (`new_message`, `conversation_updated`).
* When you open the **WhatsApp Chat** page (`/whatsapp/chat`):
  * The contact appears in the left conversation list with their name, phone number, and unread badge.
  * Clicking on the lead displays the full conversation history (template sent &rarr; customer reply &rarr; AI response &rarr; manual replies).
  * Sales agents can seamlessly take over the chat and reply manually at any time.

---

## 8. Summary of Relevant File Locations

| Component | File Path |
|---|---|
| **Excel Lead Importer Modal** | `SALESBUSTER-CRM-FRONTEND/src/components/leads/ImportLeadsModal.jsx` |
| **Leads Directory Page** | `SALESBUSTER-CRM-FRONTEND/src/pages/Leads.jsx` |
| **Campaigns Dashboard** | `SALESBUSTER-CRM-FRONTEND/src/pages/WhatsAppCampaigns.jsx` |
| **5-Step Campaign Wizard** | `SALESBUSTER-CRM-FRONTEND/src/pages/CreateCampaign.jsx` |
| **Cloud Settings Modal** | `SALESBUSTER-CRM-FRONTEND/src/components/whatsapp/CloudSettingsModal.jsx` |
| **Template Sync Page** | `SALESBUSTER-CRM-FRONTEND/src/pages/WhatsAppTemplates.jsx` |
| **Backend Lead Controller (Import)** | `SALESBUSTER-CRM-BACKEND/controllers/leadController.js` |
| **Backend Lead Routes** | `SALESBUSTER-CRM-BACKEND/routes/leadRoutes.js` |
| **Backend Campaign Controller** | `SALESBUSTER-CRM-BACKEND/controllers/whatsappCampaignController.js` |
| **Backend Cloud API Controller** | `SALESBUSTER-CRM-BACKEND/controllers/whatsappCloudController.js` |
| **Background Campaign Queue Worker** | `SALESBUSTER-CRM-BACKEND/services/whatsappCampaignWorker.js` |
| **Meta Cloud Graph API Service** | `SALESBUSTER-CRM-BACKEND/services/whatsappCloudService.js` |
| **Webhook Delivery & AI Reply Controller**| `SALESBUSTER-CRM-BACKEND/controllers/whatsappWebhookController.js` |

---

## 9. Meta Graph API Versioning (v21.0 vs v26.0)

* **Current Code Default**: The codebase is configured to default to **`v26.0`** (`https://graph.facebook.com/v26.0`), which is Meta's latest active Graph API release.
* **Why do many tutorials/docs cite `v21.0`?**
  * Meta's developer documentation, sample Postman collections, and community tutorials were heavily written around `v21.0` (a major LTS release).
  * Meta maintains active support for every Graph API version for **at least 2 years** from release. Both `v21.0` and `v26.0` are actively supported by Meta's servers.
* **Configurable via Environment Variable**:
  * You can override or lock your Meta API version anytime in `.env`:
    ```bash
    META_GRAPH_API_VERSION=v26.0
    # or
    META_GRAPH_API_VERSION=v21.0
    ```

