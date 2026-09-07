import Notification from "../models/Notification.js";

// @desc    Get all notifications for the logged in user
// @route   GET /api/notifications
// @access  Private
export const getNotifications = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user._id;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = {
      $or: [
        { targetRoles: { $in: [userRole] } },
        { targetUsers: { $in: [userId] } },
      ],
    };

    const total = await Notification.countDocuments(query);
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Map to frontend expected format
    const formatted = notifications.map((n) => ({
      id: n._id,
      title: n.title,
      message: n.message,
      type: n.type,
      time: n.createdAt,
      read: n.readBy.includes(userId),
    }));

    const hasMore = total > skip + notifications.length;

    res.status(200).json({ success: true, notifications: formatted, hasMore });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error while fetching notifications" });
  }
};

// @desc    Mark a notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
export const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    if (!notification.readBy.includes(req.user._id)) {
      notification.readBy.push(req.user._id);
      await notification.save();
    }

    res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// @desc    Delete (hide) a notification for user
// @route   DELETE /api/notifications/:id
// @access  Private
export const deleteNotification = async (req, res) => {
  try {
    // For simplicity, we actually delete it from DB if they want to hide it,
    // OR we could just have a 'hiddenBy' array.
    // Given the simple requirement, we'll just delete it if the user removes it.
    await Notification.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: "Notification removed" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
