import { Server } from "socket.io";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`Socket.IO client connected: ${socket.id}`);

    // Join room for specific lead chat page to support streaming messages
    socket.on("join_lead_chat", (leadId) => {
      if (leadId) {
        socket.join(leadId);
        console.log(`Socket ${socket.id} joined room: ${leadId}`);
      }
    });

    socket.on("leave_lead_chat", (leadId) => {
      if (leadId) {
        socket.leave(leadId);
        console.log(`Socket ${socket.id} left room: ${leadId}`);
      }
    });

    // Join room for specific organization for multi-tenant isolation
    socket.on("join_organization", (orgId) => {
      if (orgId) {
        const roomName = String(orgId).startsWith("org_") ? String(orgId) : `org_${orgId}`;
        socket.join(roomName);
        console.log(`Socket ${socket.id} joined organization room: ${roomName}`);
      }
    });

    socket.on("leave_organization", (orgId) => {
      if (orgId) {
        const roomName = String(orgId).startsWith("org_") ? String(orgId) : `org_${orgId}`;
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
