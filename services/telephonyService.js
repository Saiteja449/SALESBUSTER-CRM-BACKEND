import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeAudioFile } from "./audioAnalysisService.js";
import { getIO } from "../socket/socket.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Downloads call recording from TeleCMI and archives it locally under uploads/recordings.
 * Uses native fetch (zero external dependencies).
 */
export const downloadAndArchiveRecording = async (
  appId,
  secret,
  filename,
  orgId = "default",
  cmiuid = Date.now().toString()
) => {
  if (!filename) return null;

  try {
    // Primary: TeleCMI official v2 Play Audio endpoint (GET https://rest.telecmi.com/v2/play)
    const telecmiUrlV2 = `https://rest.telecmi.com/v2/play?appid=${encodeURIComponent(
      appId || ""
    )}&secret=${encodeURIComponent(secret || "")}&file=${encodeURIComponent(
      filename
    )}`;

    console.log(`[TelephonyService] Downloading recording for call ${cmiuid} via v2/play endpoint...`);

    let response = await fetch(telecmiUrlV2);
    let chosenUrl = telecmiUrlV2;
    let isAudio = false;
    let buffer = null;

    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const arrayBuffer = await response.arrayBuffer();
      const tempBuf = Buffer.from(arrayBuffer);

      // Check if response is error JSON or HTML rather than real audio
      if (
        contentType.includes("application/json") ||
        contentType.includes("text/html") ||
        (tempBuf.length < 300 && tempBuf.toString().includes("error"))
      ) {
        console.warn(
          `[TelephonyService] TeleCMI v2/play returned non-audio response:`,
          tempBuf.toString("utf8")
        );
      } else if (tempBuf.length > 200) {
        isAudio = true;
        buffer = tempBuf;
      }
    }

    // Secondary fallback to v3/piopiy/play if v2 did not return valid audio
    if (!isAudio) {
      console.warn(
        `[TelephonyService] TeleCMI v2/play did not yield audio (status ${response?.status}). Attempting v3 fallback...`
      );
      const telecmiUrlV3 = `https://rest.telecmi.com/v3/piopiy/play?appid=${encodeURIComponent(
        appId || ""
      )}&secret=${encodeURIComponent(secret || "")}&file=${encodeURIComponent(
        filename
      )}`;
      const v3Response = await fetch(telecmiUrlV3).catch(() => null);
      if (v3Response && v3Response.ok) {
        const contentType = v3Response.headers.get("content-type") || "";
        const arrayBuffer = await v3Response.arrayBuffer();
        const tempBuf = Buffer.from(arrayBuffer);
        if (!contentType.includes("application/json") && !contentType.includes("text/html") && tempBuf.length > 200) {
          isAudio = true;
          buffer = tempBuf;
          chosenUrl = telecmiUrlV3;
        }
      }
    }

    if (!isAudio || !buffer) {
      console.warn(
        `[TelephonyService] TeleCMI recording fetch failed for ${filename}. Using direct URL fallback.`
      );
      return {
        publicUrl: chosenUrl,
        localPath: null,
        fileSize: 0,
      };
    }

    // Save locally under uploads/recordings/:orgId/:cmiuid.mp3
    const recordingsDir = path.join(
      __dirname,
      "..",
      "uploads",
      "recordings",
      String(orgId)
    );

    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    const localFileName = `${cmiuid}.mp3`;
    const localFilePath = path.join(recordingsDir, localFileName);
    fs.writeFileSync(localFilePath, buffer);

    const backendBase = (
      process.env.BACKEND_URL ||
      process.env.API_URL ||
      "https://betaapi.salesbuster.ai"
    ).replace(/\/+$/, "");
    const publicUrl = `${backendBase}/uploads/recordings/${orgId}/${localFileName}`;
    console.log(
      `[TelephonyService] Recording saved successfully: ${publicUrl} (${buffer.length} bytes)`
    );

    return {
      publicUrl,
      localPath: localFilePath,
      fileSize: buffer.length,
    };
  } catch (error) {
    console.error("[TelephonyService] Error archiving recording:", error.message);
    const fallbackUrl = `https://rest.telecmi.com/v2/play?appid=${encodeURIComponent(
      appId || ""
    )}&secret=${encodeURIComponent(secret || "")}&file=${encodeURIComponent(
      filename
    )}`;
    return {
      publicUrl: fallbackUrl,
      localPath: null,
      fileSize: 0,
    };
  }
};

/**
 * Triggers background AI transcription and analysis for a recorded call
 */
export const triggerCallAiAnalysis = async ({
  localPath,
  publicUrl,
  leadId,
  callLogId,
  organization,
  tenantModels,
}) => {
  if (!localPath || !fs.existsSync(localPath)) return;

  const apiKey =
    organization?.aiSettings?.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.log(
      "[TelephonyService] Skipping AI analysis: No Gemini API Key configured."
    );
    return;
  }

  // Run in background (non-blocking)
  (async () => {
    try {
      console.log(`[TelephonyService] Running Gemini AI analysis for call ${callLogId}...`);
      const { Lead, CallLog } = tenantModels;

      const result = await analyzeAudioFile(localPath, "audio/mpeg", apiKey);

      if (CallLog && callLogId) {
        await CallLog.findByIdAndUpdate(callLogId, {
          aiAnalysisStatus: "completed",
          aiSummary: result.analysis || result.transcription || "",
        });
      }

      if (Lead && leadId) {
        await Lead.updateOne(
          { _id: leadId, "recordings.url": publicUrl },
          {
            $set: {
              "recordings.$.transcription": result.transcription || "",
              "recordings.$.analysis": result.analysis || "",
              "recordings.$.analysisStatus": "completed",
            },
          }
        );
      }

      // Broadcast update via Socket.io
      const io = getIO();
      if (io && organization?._id) {
        io.to(organization._id.toString()).emit("recording_analyzed", {
          leadId,
          callLogId,
          transcription: result.transcription,
          analysis: result.analysis,
          analysisStatus: "completed",
        });
      }

      console.log(`[TelephonyService] Gemini AI analysis completed for call ${callLogId}`);
    } catch (err) {
      console.error(
        `[TelephonyService] AI analysis failed for call ${callLogId}:`,
        err.message
      );
      if (tenantModels?.CallLog && callLogId) {
        await tenantModels.CallLog.findByIdAndUpdate(callLogId, {
          aiAnalysisStatus: "failed",
        }).catch(() => {});
      }
    }
  })();
};

/**
 * Automatically provisions an agent user extension in TeleCMI via REST API
 * POST https://rest.telecmi.com/v3/user/add (v3 only, no v2 fallback)
 */
export const provisionTelecmiUser = async ({
  name,
  email,
  phone,
  password,
  extension,
  organization,
}) => {
  if (
    !organization?.telephony?.isAddonEnabled ||
    !organization?.telephony?.isConfigured
  ) {
    return null;
  }

  const { telecmiAppId, telecmiSecret } = organization.telephony;
  if (!telecmiAppId || !telecmiSecret) return null;

  try {
    const cleanPhone = String(phone || "").replace(/\D/g, "");
    const formattedPhone =
      cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

    // TeleCMI v3 requires a 4-digit extension between 1000 and 9999
    let extNum = parseInt(extension, 10);
    if (isNaN(extNum) || extNum < 1000 || extNum > 9999) {
      if (!isNaN(extNum) && extNum >= 100 && extNum <= 999) {
        extNum = extNum + 1000;
      } else {
        extNum = 1001;
      }
    }

    // TeleCMI v3 requires separate mandatory first_name and last_name
    const nameParts = String(name || "Agent User").trim().split(/\s+/);
    const firstName = nameParts[0] || "Agent";
    const lastName = nameParts.slice(1).join(" ") || "User";

    // TeleCMI v3 requires minimum 8 character password
    let sipPassword = String(password || "").trim();
    if (sipPassword.length < 8) {
      sipPassword = sipPassword
        ? `${sipPassword}Pass@123`
        : `SipPass@${Math.floor(1000 + Math.random() * 9000)}`;
    }

    // TeleCMI v3 requires mandatory email_id
    const userEmail =
      email && String(email).includes("@")
        ? String(email).trim()
        : `${firstName.toLowerCase()}${extNum}@telecmi.internal`;

    console.log(
      `[TelephonyService] Auto-provisioning TeleCMI user ${firstName} ${lastName} (ext ${extNum}) via v3 API...`
    );

    const payload = {
      appid: Number(telecmiAppId) || telecmiAppId,
      secret: telecmiSecret,
      extension: extNum,
      first_name: firstName,
      last_name: lastName,
      email_id: userEmail,
      phone_number: formattedPhone,
      password: sipPassword,
      start_time: 1,
      end_time: 24,
      followme: true,
    };

    // Exclusively call TeleCMI v3 User Add endpoint
    const response = await fetch("https://rest.telecmi.com/v3/user/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error(
        "[TelephonyService] Network failure calling TeleCMI v3 user/add:",
        err.message
      );
      return null;
    });

    if (!response || !response.ok) {
      const errText = response
        ? await response.text().catch(() => "")
        : "No response";
      console.error(
        `[TelephonyService] TeleCMI v3 user/add failed with status ${response?.status}: ${errText}`
      );
      return null;
    }

    const data = await response.json().catch(() => ({}));
    console.log("[TelephonyService] TeleCMI v3 user/add API response:", data);

    if (data.code && data.code !== 200 && data.status !== "success") {
      console.error(
        `[TelephonyService] TeleCMI v3 rejected user add: ${data.msg || "Unknown error"}`
      );
      return null;
    }

    const telecmiUserId = data.agent?.agent_id || `${extNum}_${telecmiAppId}`;
    const confirmedExtension = String(data.agent?.extension || extNum);

    return {
      success: true,
      telecmiUserId,
      telecmiPassword: sipPassword,
      telecmiExtension: confirmedExtension,
      rawResponse: data,
    };
  } catch (error) {
    console.error(
      "[TelephonyService] Error provisioning TeleCMI user via v3:",
      error.message
    );
    return null;
  }
};

/**
 * Automatically removes an agent user extension in TeleCMI via REST API
 * POST https://rest.telecmi.com/v3/user/remove
 */
export const removeTelecmiUser = async ({ agentId, organization }) => {
  if (
    !organization?.telephony?.isAddonEnabled ||
    !organization?.telephony?.isConfigured
  ) {
    return null;
  }

  const { telecmiAppId, telecmiSecret } = organization.telephony;
  if (!telecmiAppId || !telecmiSecret || !agentId) return null;

  try {
    console.log(
      `[TelephonyService] Auto-removing TeleCMI user ${agentId} via v3 API...`
    );

    const payload = {
      appid: Number(telecmiAppId) || telecmiAppId,
      secret: telecmiSecret,
      agent_id: String(agentId).trim(),
    };

    const response = await fetch("https://rest.telecmi.com/v3/user/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error(
        "[TelephonyService] Network failure calling TeleCMI v3 user/remove:",
        err.message
      );
      return null;
    });

    if (!response || !response.ok) {
      const errText = response
        ? await response.text().catch(() => "")
        : "No response";
      console.error(
        `[TelephonyService] TeleCMI v3 user/remove failed with status ${response?.status}: ${errText}`
      );
      return null;
    }

    const data = await response.json().catch(() => ({}));
    console.log("[TelephonyService] TeleCMI v3 user/remove API response:", data);

    const isSuccess = data.code === 200 || data.status === "success";
    return {
      success: isSuccess,
      rawResponse: data,
    };
  } catch (error) {
    console.error(
      "[TelephonyService] Error removing TeleCMI user via v3:",
      error.message
    );
    return null;
  }
};


