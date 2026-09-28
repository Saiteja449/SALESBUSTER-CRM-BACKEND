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
    // Primary: TeleCMI v3 API Endpoint
    const telecmiUrlV3 = `https://rest.telecmi.com/v3/piopiy/play?appid=${encodeURIComponent(
      appId || ""
    )}&secret=${encodeURIComponent(secret || "")}&file=${encodeURIComponent(
      filename
    )}`;

    console.log(`[TelephonyService] Downloading recording for call ${cmiuid} via v3 endpoint...`);

    let response = await fetch(telecmiUrlV3);
    let chosenUrl = telecmiUrlV3;

    // Fallback to v2 if v3 returns 404 or fails
    if (!response.ok) {
      console.warn(
        `[TelephonyService] TeleCMI v3 recording fetch returned status ${response.status}. Attempting v2 fallback...`
      );
      const telecmiUrlV2 = `https://rest.telecmi.com/v2/piopiy/play?appid=${encodeURIComponent(
        appId || ""
      )}&secret=${encodeURIComponent(secret || "")}&file=${encodeURIComponent(
        filename
      )}`;
      const v2Response = await fetch(telecmiUrlV2).catch(() => null);
      if (v2Response && v2Response.ok) {
        response = v2Response;
        chosenUrl = telecmiUrlV2;
      }
    }

    if (!response.ok) {
      console.warn(
        `[TelephonyService] TeleCMI recording fetch returned status ${response.status}. Using direct URL fallback.`
      );
      return {
        publicUrl: chosenUrl,
        localPath: null,
        fileSize: 0,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
    const fallbackUrl = `https://rest.telecmi.com/v3/piopiy/play?appid=${encodeURIComponent(
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
      `[TelephonyService] Auto-provisioning TeleCMI user ${name} with extension ${ext} via v3 API...`
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

    // Primary: v3 endpoint
    let response = await fetch("https://rest.telecmi.com/v3/user/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch(() => null);

    // Fallback to v2 if v3 is unavailable or returns an error status
    if (!response || !response.ok) {
      console.warn(
        `[TelephonyService] TeleCMI v3 user/add returned ${response?.status || "network failure"}. Trying v2 endpoint...`
      );
      const v2Response = await fetch("https://rest.telecmi.com/v2/user/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }).catch(() => null);

      if (v2Response) {
        response = v2Response;
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

