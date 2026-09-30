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

    const publicUrl = `/uploads/recordings/${orgId}/${localFileName}`;
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
 * POST https://rest.telecmi.com/v3/user/add (with v2 fallback)
 */
export const provisionTelecmiUser = async ({
  name,
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
    const ext = parseInt(extension) || 101;

    console.log(
      `[TelephonyService] Auto-provisioning TeleCMI user ${name} with extension ${ext} via v2 API...`
    );

    const payload = {
      appid: Number(telecmiAppId) || telecmiAppId,
      secret: telecmiSecret,
      extension: ext,
      name: name,
      phone_number: formattedPhone,
      password: password || "123456",
      start_time: 1,
      end_time: 24,
      sms_alert: false,
    };

    // Primary: TeleCMI official v2 User Operations endpoint
    let response = await fetch("https://rest.telecmi.com/v2/user/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch(() => null);

    // Fallback to v3 if v2 fails
    if (!response || !response.ok) {
      console.warn(
        `[TelephonyService] TeleCMI v2 user/add returned ${response?.status || "network failure"}. Trying v3 fallback...`
      );
      const v3Response = await fetch("https://rest.telecmi.com/v3/user/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }).catch(() => null);

      if (v3Response) {
        response = v3Response;
      }
    }

    const data = response ? await response.json().catch(() => ({})) : {};
    console.log("[TelephonyService] TeleCMI user/add API response:", data);

    const telecmiUserId = `${ext}_${telecmiAppId}`;

    return {
      success: true,
      telecmiUserId,
      telecmiPassword: password || "123456",
      telecmiExtension: String(ext),
      rawResponse: data,
    };
  } catch (error) {
    console.error(
      "[TelephonyService] Error provisioning TeleCMI user:",
      error.message
    );
    return null;
  }
};

