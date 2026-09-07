import Followup from "../models/Followup.js";
import Notification from "../models/Notification.js";

const getModels = (req) => ({
  FollowupModel: req.tenantModels?.Followup || Followup,
  NotificationModel: req.tenantModels?.Notification || Notification,
});

// @desc    Get all followups
// @route   GET /api/followups
// @access  Public / Protected
export const getFollowups = async (req, res) => {
  try {
    const { FollowupModel } = getModels(req);
    const followups = await FollowupModel.find().sort({ createdAt: -1 });
    res.json({ success: true, data: followups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a followup
// @route   POST /api/followups
// @access  Public / Protected
export const createFollowup = async (req, res) => {
  try {
    const {
      leadId,
      leadName,
      type,
      date,
      time,
      priority,
      notes,
      author,
      done,
    } = req.body;

    const { FollowupModel, NotificationModel } = getModels(req);

    const followup = new FollowupModel({
      leadId,
      leadName,
      type,
      date,
      time,
      priority,
      notes,
      author,
      done,
    });
    const createdFollowup = await followup.save();

    if (type !== "Lead Edited") {
      await NotificationModel.create({
        title: "New Follow-up Scheduled",
        message: `A follow-up was scheduled for lead ${leadName} by ${author}.`,
        type: "system",
        targetRoles: ["sales manager"],
      });
    }

    res.status(201).json({ success: true, data: createdFollowup });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update a followup
// @route   PUT /api/followups/:id
// @access  Public / Protected
export const updateFollowup = async (req, res) => {
  try {
    const { FollowupModel } = getModels(req);
    const followup = await FollowupModel.findById(req.params.id);

    if (followup) {
      followup.done =
        req.body.done !== undefined ? req.body.done : followup.done;

      const updatedFollowup = await followup.save();
      res.json({ success: true, data: updatedFollowup });
    } else {
      res.status(404).json({ success: false, message: "Followup not found" });
    }
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
