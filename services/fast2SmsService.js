/**
 * Fast2SMS DLT SMS Service
 * Dispatches 4-digit OTP messages using Fast2SMS DLT API
 */

export const sendDltOtp = async (phoneNumber, otp) => {
  const f2sUrl = process.env.F2S_URL ;
  const apiKey = process.env.F2S_KEY;
  const senderId = process.env.F2S_SENDER_ID ;
  const templateId = process.env.F2S_DLT_TEMPLATE_ID;

  const cleanPhone = String(phoneNumber).replace(/\D/g, "").slice(-10);

  if (cleanPhone.length !== 10) {
    throw new Error(`Invalid mobile number: ${phoneNumber}. Must be 10 digits.`);
  }

  if (!apiKey) {
    console.warn(
      `[Fast2SMS] F2S_KEY is not defined in environment. Skipping network call in dev mode. OTP is: ${otp}`
    );
    return {
      success: true,
      simulated: true,
      message: "Fast2SMS API key missing, simulated delivery in development",
      otp,
    };
  }

  // Fast2SMS accepts application/x-www-form-urlencoded
  const params = new URLSearchParams();
  params.append("sender_id", senderId);
  params.append("message", templateId);
  params.append("route", "dlt");
  params.append("numbers", cleanPhone);
  params.append("variables_values", String(otp)); // Single 4-digit OTP value

  try {
    const response = await fetch(f2sUrl, {
      method: "POST",
      headers: {
        authorization: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || (data && data.return === false)) {
      const errMsg =
        data?.message?.[0] || data?.message || `Fast2SMS HTTP Error ${response.status}`;
      console.error(`[Fast2SMS] Failed to send OTP to ${cleanPhone}:`, errMsg, data);
      return {
        success: false,
        status: response.status,
        message: errMsg,
        data,
      };
    }

    console.log(`[Fast2SMS] OTP successfully sent to ${cleanPhone}. Response:`, data);
    return {
      success: true,
      data,
    };
  } catch (error) {
    console.error(`[Fast2SMS] Network exception sending OTP to ${cleanPhone}:`, error);
    return {
      success: false,
      message: error.message || "Failed to reach Fast2SMS gateway",
    };
  }
};
