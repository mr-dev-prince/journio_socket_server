import mongoose from "mongoose";
import Conversation from "../model/conversation.model";
import Message from "../model/message.model";

export async function getOrCreateConversation(
  userId1: string,
  userId2: string
) {
  let conversation = await Conversation.findOne({
    participants: { $all: [userId1, userId2] },
  });

  if (!conversation) {
    conversation = await Conversation.create({
      participants: [userId1, userId2],
    });
  }

  return conversation;
}

export async function addMessage(
  conversationId: mongoose.Types.ObjectId,
  senderId: string,
  receiverId: string,
  content: string
) {
  const message = await Message.create({
    conversationId,
    sender: senderId,
    receiver: receiverId,
    content,
  });

  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessage: message._id,
  });

  return message;
}
