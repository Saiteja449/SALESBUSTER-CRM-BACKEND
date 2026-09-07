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

    socket.on("disconnect", () => {
      console.log(`Socket.IO client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  return io;
};
