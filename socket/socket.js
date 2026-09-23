import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { getTenantModels } from "../services/tenantManager.js";

let io;

/**
 * Socket.IO Authentication Middleware
 * Validates JWT before allowing any socket connection
 */
export const socketAuthMiddleware = (socket, next) => {
  try {
    const authHeader =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization;

    if (!authHeader) {
      return next(new Error("Authentication error: Token required"));
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    console.warn(`[Socket Security] Connection rejected: ${err.message}`);
    return next(new Error("Authentication error: Invalid or expired token"));
  }
};

/**
 * Production handler for joining a lead chat room
 * Fail-closed: Denies join if tenant model cannot be resolved, if lead not found,
 * or if a sales representative is not assigned to the lead.
 */
export const handleJoinLeadChat = async (socket, leadId, options = {}) => {
  if (!leadId || !socket?.user) return;
  try {
    const tenantDbName = socket.user.tenantDbName;
    const models = options.tenantModels || (tenantDbName ? getTenantModels(tenantDbName) : null);
    const LeadModel = options.LeadModel || models?.Lead;

    // Security: Fail-closed if tenant model cannot be resolved
    if (!LeadModel) {
      console.warn(
        `[Socket Security] Access denied: LeadModel could not be resolved for user ${socket.user.id}`
      );
      socket.emit("security_error", {
        message: "Access denied. Tenant context could not be resolved.",
      });
      return;
    }

    const lead = await LeadModel.findById(leadId).select("assignedTo").lean();
    if (!lead) {
      console.warn(`[Socket Security] Lead ${leadId} not found for join_lead_chat`);
      socket.emit("security_error", {
        message: "Access denied. Lead not found.",
      });
      return;
    }

    // Sales rep authorization: only leads assigned to this rep
    if (socket.user.role === "sales person") {
      const repId = socket.user.id?.toString();
      const repName = socket.user.name;
      const isAssigned =
        lead.assignedTo?.toString() === repId ||
        (repName && lead.assignedTo === repName);

      if (!isAssigned) {
        console.warn(
          `[Socket Security] Rep ${repId} denied join to unassigned lead chat: ${leadId}`
        );
        socket.emit("security_error", {
          message: "Access denied. You are not assigned to this conversation.",
        });
        return;
      }
    }

    socket.join(leadId);
    console.log(`Socket ${socket.id} joined room: ${leadId}`);
  } catch (err) {
    console.error(`[Socket Security] Error in join_lead_chat for ${leadId}:`, err.message);
    socket.emit("security_error", {
      message: "Internal error verifying lead room access.",
    });
  }
};

/**
 * Production handler for joining an organization room
 * Restricts access to members of the requested organization or super_admins.
 */
export const handleJoinOrganization = (socket, orgId) => {
  if (!orgId || !socket?.user) return;
  const cleanOrgId = String(orgId).replace(/^org_/, "").trim();
  const userOrgId = String(socket.user.organizationId || "").replace(/^org_/, "").trim();
  const userRole = socket.user.role;

// Cross-tenant protection: Super admin or matching organization only
  if (userRole === "super_admin" || (cleanOrgId && userOrgId === cleanOrgId)) {
    const roomName = `org_${cleanOrgId}`;
    socket.join(roomName);

    // Join user's personal private room
    const userId = (socket.user.id || socket.user._id || "").toString();
    if (userId) {
      socket.join(`user_${userId}`);
    }

    // Join admin leadership room for authorized managers and super admins
    const isLeadership =
      userRole === "super_admin" ||
      userRole === "sales manager" ||
      socket.user.isOrgOwner;
    if (isLeadership) {
      socket.join(`org_${cleanOrgId}_admins`);
    }

    console.log(
      `Socket ${socket.id} (user: ${userId}, role: ${userRole}) joined organization room: ${roomName}`
    );
  } else {
    console.warn(
      `[Socket Security] Access denied: User ${socket.user.id} tried to join foreign org room: ${cleanOrgId}`
    );
    socket.emit("security_error", { message: "Access denied to organization room." });
  }
};

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    const userId = (socket.user?.id || socket.user?._id || "").toString();
    if (userId) {
      socket.join(`user_${userId}`);
    }
    const userRole = socket.user?.role;
    const userOrgId = String(socket.user?.organizationId || "").replace(/^org_/, "").trim();
    if (userOrgId && (userRole === "super_admin" || userRole === "sales manager" || socket.user?.isOrgOwner)) {
      socket.join(`org_${userOrgId}_admins`);
    }

    console.log(`Socket.IO client connected: ${socket.id} (user: ${userId})`);

    socket.on("join_lead_chat", (leadId) => handleJoinLeadChat(socket, leadId));

    socket.on("leave_lead_chat", (leadId) => {
      if (leadId) {
        socket.leave(leadId);
        console.log(`Socket ${socket.id} left room: ${leadId}`);
      }
    });

    socket.on("join_organization", (orgId) => handleJoinOrganization(socket, orgId));

    socket.on("leave_organization", (orgId) => {
      if (orgId) {
        const cleanOrgId = String(orgId).replace(/^org_/, "").trim();
        const roomName = `org_${cleanOrgId}`;
        socket.leave(roomName);
        console.log(`Socket ${socket.id} left organization room: ${roomName}`);
      }
    });

    socket.on("disconnect", () => {
      console.log(`Socket.IO client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  return io;
};
