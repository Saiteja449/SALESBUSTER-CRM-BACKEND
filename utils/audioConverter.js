import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import path from "path";

// Set the path to the ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Converts an audio file to MP3 format
 * @param {string} inputPath - The path to the source audio file
 * @param {string} outputPath - The destination path for the MP3 file
 * @returns {Promise<string>} - Resolves with the outputPath on success
 */
export const convertToMp3 = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Input file does not exist: ${inputPath}`));
    }

    console.log(`[AudioConverter] Starting conversion: ${inputPath} -> ${outputPath}`);

    ffmpeg(inputPath)
      .toFormat("mp3")
      .audioCodec("libmp3lame")
      .on("end", () => {
        console.log(`[AudioConverter] Conversion finished: ${outputPath}`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error(`[AudioConverter] Conversion error:`, err);
        reject(err);
      })
      .save(outputPath);
  });
};

/**
 * Checks if a file needs to be converted to MP3 based on its extension or mimetype
 * @param {string} filename - The name of the file
 * @param {string} mimetype - The mime type of the file
 * @returns {boolean}
 */
export const needsConversion = (filename, mimetype) => {
  const ext = path.extname(filename).toLowerCase();
  
  // Browsers generally support .mp3, .wav natively well.
  // Common formats that cause issues or need conversion for Gemini: .awb, .amr, .m4a, .aac, .ogg
  const supportedNativeExts = [".mp3", ".wav"];
  
  if (!supportedNativeExts.includes(ext)) {
    return true;
  }
  
  return false;
};

/**
 * Processes an uploaded file object (e.g. from multer) and converts it to MP3 if necessary.
 * Mutates the file object in place so subsequent code uses the MP3 version.
 * @param {Object} reqFile - The file object from req.file
 */
export const processAudioUpload = async (reqFile) => {
  if (!reqFile) return;
  
  if (needsConversion(reqFile.originalname, reqFile.mimetype)) {
    try {
      const parsedPath = path.parse(reqFile.path);
      const newFilename = `${parsedPath.name}.mp3`;
      const newPath = path.join(parsedPath.dir, newFilename);
      
      await convertToMp3(reqFile.path, newPath);
      
      // Cleanup old file
      if (fs.existsSync(reqFile.path)) {
        fs.unlinkSync(reqFile.path);
      }
      
      // Update reqFile to point to the new MP3
      reqFile.path = newPath;
      reqFile.filename = newFilename;
      reqFile.mimetype = "audio/mpeg";
      
      // Ensure the originalName has .mp3 extension
      const oldExt = path.extname(reqFile.originalname);
      if (oldExt) {
        reqFile.originalname = reqFile.originalname.replace(oldExt, ".mp3");
      } else {
        reqFile.originalname = `${reqFile.originalname}.mp3`;
      }
    } catch (err) {
      console.error("[AudioConverter] Audio conversion failed, proceeding with original file:", err);
    }
  }
};
