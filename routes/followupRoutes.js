import express from "express";
import { getFollowups, createFollowup, updateFollowup } from "../controllers/followupController.js";
// import { runFollowupCheck } from "../cron/followupCron.js";

const router = express.Router();

router.route("/").get(getFollowups).post(createFollowup);
router.route("/:id").put(updateFollowup);

router.post("/trigger-cron", async (req, res) => {
  try {
    console.log("[MANUAL] Triggering automated follow-up check...");
    // runFollowupCheck();

    res.json({ message: "Automated follow-up check triggered successfully!" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
