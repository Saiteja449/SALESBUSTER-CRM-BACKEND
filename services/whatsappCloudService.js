const getGraphApiVersion = () => process.env.META_GRAPH_API_VERSION || "v26.0";
const getGraphApiBaseUrl = () =>
  `https://graph.facebook.com/${getGraphApiVersion()}`;

/**
 * Parses standard Meta Graph API errors into a normalized object.
 */
export const parseMetaError = (errorData, status = 500) => {
  const metaErr = errorData?.error || {};
  return {
    status,
    code: metaErr.code || status,
    subcode: metaErr.error_subcode || null,
    type: metaErr.type || "MetaApiError",
    message: metaErr.message || "Unknown Meta Graph API error",
    userTitle: metaErr.error_user_title || "",
    userMsg: metaErr.error_user_msg || "",
    fbtraceId: metaErr.fbtrace_id || null,
  };
};

/**
 * Verifies a Phone Number ID and Access Token against Meta Graph API.
 */
export const verifyCredentials = async (phoneNumberId, accessToken) => {
  if (!phoneNumberId || !accessToken) {
    throw new Error("phoneNumberId and accessToken are required.");
  }

  const url = `${getGraphApiBaseUrl()}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,messaging_limit_tier`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    const parsed = parseMetaError(data, res.status);
    const err = new Error(`Meta API error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  return {
    phoneNumberId,
    verifiedName: data.verified_name || "",
    displayPhoneNumber: data.display_phone_number || "",
    qualityRating: data.quality_rating || "UNKNOWN",
    codeVerificationStatus: data.code_verification_status || "",
    messagingLimitTier: data.messaging_limit_tier || "TIER_1K",
  };
};

/**
 * Fetches approved message templates from Meta WABA.
 */
export const fetchTemplates = async (wabaId, accessToken) => {
  if (!wabaId || !accessToken) {
    throw new Error("wabaId and accessToken are required.");
  }

  let templates = [];
  let nextUrl = `${getGraphApiBaseUrl()}/${wabaId}/message_templates?limit=100`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      const parsed = parseMetaError(data, res.status);
      const err = new Error(`Meta API error (${parsed.code}): ${parsed.message}`);
      err.meta = parsed;
      throw err;
    }

    if (Array.isArray(data.data)) {
      templates = templates.concat(data.data);
    }

    nextUrl = data.paging?.next || null;
  }

  return templates;
};

/**
 * Dispatches an approved WhatsApp template message to a recipient.
 */
export const sendTemplateMessage = async ({
  phoneNumberId,
  accessToken,
  toPhone,
  templateName,
  languageCode = "en_US",
  components = [],
}) => {
  if (!phoneNumberId || !accessToken || !toPhone || !templateName) {
    throw new Error(
      "phoneNumberId, accessToken, toPhone, and templateName are required."
    );
  }

  // Ensure digits only for recipient phone
  const cleanPhone = String(toPhone).replace(/\D/g, "");

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleanPhone,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
    },
  };

  if (Array.isArray(components) && components.length > 0) {
    payload.template.components = components;
  }

  const url = `${getGraphApiBaseUrl()}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    const parsed = parseMetaError(data, res.status);
    const err = new Error(`Meta Send Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  const metaMessageId = data.messages?.[0]?.id || null;
  return {
    metaMessageId,
    contact: data.contacts?.[0] || null,
  };
};

/**
 * Sends a free-form conversational text message within the 24-hour service window.
 */
export const sendTextMessage = async ({
  phoneNumberId,
  accessToken,
  toPhone,
  textBody,
}) => {
  if (!phoneNumberId || !accessToken || !toPhone || !textBody) {
    throw new Error(
      "phoneNumberId, accessToken, toPhone, and textBody are required."
    );
  }

  const cleanPhone = String(toPhone).replace(/\D/g, "");

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleanPhone,
    type: "text",
    text: {
      preview_url: false,
      body: String(textBody),
    },
  };

  const url = `${getGraphApiBaseUrl()}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    const parsed = parseMetaError(data, res.status);
    const err = new Error(`Meta Text Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  const metaMessageId = data.messages?.[0]?.id || null;
  return {
    metaMessageId,
    contact: data.contacts?.[0] || null,
  };
};

/**
 * Checks phone number quality rating and throughput health.
 */
export const getPhoneNumberHealth = async (phoneNumberId, accessToken) => {
  return verifyCredentials(phoneNumberId, accessToken);
};

/**
 * Uploads a sample media file using Meta's Resumable Upload API to get a header_handle.
 */
export const uploadResumableMedia = async (accessToken, fileBuffer, mimeType, fileName = "sample_media") => {
  if (!accessToken || !fileBuffer) {
    throw new Error("accessToken and fileBuffer are required for media upload.");
  }

  // 1. Create upload session
  const sessionUrl = `${getGraphApiBaseUrl()}/app/uploads?file_length=${fileBuffer.length}&file_type=${encodeURIComponent(
    mimeType
  )}&file_name=${encodeURIComponent(fileName)}`;

  const sessionRes = await fetch(sessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const sessionData = await sessionRes.json();
  if (!sessionRes.ok || sessionData.error) {
    const parsed = parseMetaError(sessionData, sessionRes.status);
    const err = new Error(`Meta Media Session Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  const uploadSessionId = sessionData.id;
  if (!uploadSessionId) {
    throw new Error("Failed to obtain Meta upload session ID.");
  }

  // 2. Upload file binary data to obtain the handle
  const uploadUrl = `${getGraphApiBaseUrl()}/${uploadSessionId}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: "0",
      "Content-Type": "application/octet-stream",
    },
    body: fileBuffer,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || uploadData.error) {
    const parsed = parseMetaError(uploadData, uploadRes.status);
    const err = new Error(`Meta Media Upload Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  const handle = uploadData.h;
  if (!handle) {
    throw new Error("Meta upload succeeded but did not return a valid handle (h).");
  }

  return handle;
};

/**
 * Creates a message template on Meta WhatsApp Business Account (WABA).
 */
export const createMessageTemplate = async (wabaId, accessToken, templateData) => {
  if (!wabaId || !accessToken || !templateData) {
    throw new Error("wabaId, accessToken, and templateData are required.");
  }

  const url = `${getGraphApiBaseUrl()}/${wabaId}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(templateData),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    const parsed = parseMetaError(data, res.status);
    const err = new Error(`Meta Template Creation Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  return {
    id: data.id,
    status: data.status || "PENDING",
    category: data.category || templateData.category,
  };
};

/**
 * Deletes a message template from Meta WABA by name.
 */
export const deleteMessageTemplate = async (wabaId, accessToken, templateName, metaTemplateId = null) => {
  if (!wabaId || !accessToken || !templateName) {
    throw new Error("wabaId, accessToken, and templateName are required.");
  }

  let url = `${getGraphApiBaseUrl()}/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`;
  if (metaTemplateId) {
    url += `&hsm_id=${encodeURIComponent(metaTemplateId)}`;
  }

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    const parsed = parseMetaError(data, res.status);
    const err = new Error(`Meta Template Deletion Error (${parsed.code}): ${parsed.message}`);
    err.meta = parsed;
    throw err;
  }

  return {
    success: true,
  };
};

