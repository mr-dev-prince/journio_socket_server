import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import * as cookie from "cookie";
import cors from "cors";
import "dotenv/config";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { addMessage, getOrCreateConversation } from "./lib/conversation.js";
import Conversation from "./model/conversation.model.js";
import Message from "./model/message.model.js";
import connectDB from "./db/dbConnection.js";

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

const app = express();
const server = createServer(app);

connectDB();
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  },
});

io.use((socket: AuthenticatedSocket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || "");
  const accessToken = cookies.accessToken || "";

  if (!accessToken) return next(new Error("Unauthorized"));

  try {
    const decoded = jwt.verify(accessToken, process.env.ACCESS_TOKEN_SECRET!);
    socket.userId = (decoded as any)._id;
    next();
  } catch {
    next(new Error("Forbidden"));
  }
});

io.on("connection", (socket: AuthenticatedSocket) => {
  const userId = socket.userId;

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socket.join(`user:${userId}`);

  socket.on(
    "join_conversation",
    async (payload: { conversationId?: string; otherUserId?: string }) => {
      try {
        let { conversationId, otherUserId } = payload || {};
        if (!conversationId) {
          if (!otherUserId) {
            socket.emit("join_error", {
              message: "otherUserId required if no conversationId",
            });
            return;
          }
          const conv = await getOrCreateConversation(userId, otherUserId);
          conversationId = conv._id.toString();
        } else {
          // optional: validate membership
          const conv = await Conversation.findById(conversationId).lean();
          if (
            !conv ||
            Array.isArray(conv) ||
            !conv.participants ||
            !conv.participants.map(String).includes(String(userId))
          ) {
            socket.emit("join_error", {
              message: "Not authorized to join conversation",
            });
            return;
          }
        }
        socket.join(`conversation:${conversationId}`);
        socket.emit("joined_conversation", { conversationId });
      } catch (err) {
        console.error("join_conversation err", err);
        socket.emit("join_error", { message: "Failed to join conversation" });
      }
    }
  );

  socket.on(
    "send_message",
    async (
      payload: { conversationId: string; content: string; localId?: string },
      ack?: (res: any) => void
    ) => {
      try {
        const { conversationId, content, localId } = payload || ({} as any);

        if (!conversationId || !content) {
          if (ack) ack({ ok: false, error: "Invalid payload" });
          return;
        }

        // check membership
        const conv = await Conversation.findById(conversationId);

        if (!conv || !conv.participants.map(String).includes(String(userId))) {
          if (ack) ack({ ok: false, error: "Not a participant" });
          return;
        }

        // find other participant
        const other = (conv as any).participants
          .map((p: any) => String(p))
          .find((p: string) => p !== String(userId));

        if (!other) {
          if (ack) ack({ ok: false, error: "No other participant" });
          return;
        }

        // persist message using your helper
        const message = await addMessage(conv._id, userId, other, content);

        // Prepare the payload that will be acked and broadcast.
        // Convert message to plain object (so we can attach localId cleanly).
        const out = {
          ...(message.toObject ? message.toObject() : message),
          localId: localId ?? null,
        };

        // Broadcast to the conversation room
        io.to(`conversation:${conversationId}`).emit("receive_message", out);

        // Notification to receiver
        io.to(`user:${other}`).emit("new_message_notification", {
          conversationId,
          from: userId,
          messageId: message._id,
          snippet: (message.content || "").slice(0, 120),
          createdAt: message.createdAt,
        });

        if (typeof ack === "function") ack({ ok: true, message: out });
      } catch (err) {
        console.error("send_message error", err);
        if (typeof ack === "function") ack({ ok: false, error: String(err) });
      }
    }
  );

  socket.on(
    "message_read",
    async (payload: { conversationId: string; messageIds: string[] }) => {
      try {
        const { conversationId, messageIds } = payload;
        console.log("conversationId--->", conversationId);
        if (
          !conversationId ||
          !Array.isArray(messageIds) ||
          messageIds.length === 0
        )
          return;

        // Validate membership
        const conv = await Conversation.findById(conversationId);

        console.log("message ids--->", messageIds);

        if (!conv || !conv.participants.map(String).includes(String(userId)))
          return;

        const validIds = messageIds.filter((id) =>
          mongoose.isValidObjectId(id)
        );

        if (validIds.length > 0) {
          await Message.updateMany(
            { _id: { $in: messageIds }, conversationId },
            { $set: { seen: true } }
          );
        }

        io.to(`conversation:${conversationId}`).emit("message_seen", {
          conversationId,
          messageIds,
          by: userId,
        });
      } catch (err) {
        console.error("message_read err", err);
      }
    }
  );

  socket.on("disconnett", () => {
    console.log("User disconnected:", socket.id);
  });
});

app.get("/", (_, res) => {
  res.send("tsc backend for socket server is running");
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`Server is running on port ${process.env.PORT || 8080}`);
});
