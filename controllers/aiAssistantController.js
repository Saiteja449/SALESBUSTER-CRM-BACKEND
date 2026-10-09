import mongoose from "mongoose";
import AIAssistantChat from "../models/AIAssistantChat.js";
import { runSalesManagerAssistant } from "../ai/assistant/aiAssistantService.js";

/**
 * Helper to resolve AIAssistantChat model for the tenant
 */
const getChatModel = (req) => {
  return req.tenantModels?.AIAssistantChat || AIAssistantChat;
};

/**
 * Sends a message to the AI Assistant and stores the chat-wise history
 * @route POST /api/ai-assistant/chat
 */
export const sendMessage = async (req, res) => {
  try {
    const { message, chatId } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message text is required.",
      });
    }

    const cleanMessage = message.trim();
    const ChatModel = getChatModel(req);
    const userId = req.user._id || req.user.id;

    // 1. Retrieve or initialize chat session
    let chat = null;
    if (chatId && mongoose.Types.ObjectId.isValid(chatId)) {
      chat = await ChatModel.findOne({ _id: chatId, userId });
    }

    if (!chat) {
      // Create new chat session with smart title based on first query
      const truncatedTitle = cleanMessage.length > 36 ? `${cleanMessage.slice(0, 36)}...` : cleanMessage;
      chat = new ChatModel({
        userId,
        title: truncatedTitle,
        messages: [],
      });
    }

    // 2. Prepare conversation history for LLM context
    const history = (chat.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // 3. Execute LangChain Agent
    const { reply, toolsUsed, modelUsed, executionTimeMs } = await runSalesManagerAssistant({
      userMessage: cleanMessage,
      history,
      tenantModels: req.tenantModels,
      organization: req.organization,
      user: req.user,
    });

    // 4. Store user query and assistant response into chat session history
    chat.messages.push({
      role: "user",
      content: cleanMessage,
      timestamp: new Date(),
    });

    chat.messages.push({
      role: "assistant",
      content: reply,
      toolsUsed: toolsUsed || [],
      timestamp: new Date(),
    });

    await chat.save();

    res.status(200).json({
      success: true,
      chatId: chat._id.toString(),
      reply,
      toolsUsed,
      modelUsed,
      executionTimeMs,
      updatedAt: chat.updatedAt,
    });
  } catch (error) {
    console.error("[AI Assistant Controller] Error in sendMessage:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to process question through AI Assistant.",
    });
  }
};

/**
 * Retrieves all chat sessions for the authenticated Sales Manager
 * @route GET /api/ai-assistant/sessions
 */
export const getChatSessions = async (req, res) => {
  try {
    const ChatModel = getChatModel(req);
    const userId = req.user._id || req.user.id;

    const sessions = await ChatModel.find({ userId })
      .sort({ updatedAt: -1 })
      .select("title updatedAt createdAt messages")
      .lean();

    const formatted = sessions.map((s) => ({
      id: s._id.toString(),
      title: s.title || "Conversation",
      messageCount: s.messages?.length || 0,
      lastMessageSnippet:
        s.messages && s.messages.length > 0
          ? s.messages[s.messages.length - 1].content.slice(0, 60)
          : "",
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
    }));

    res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error("[AI Assistant Controller] Error in getChatSessions:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Retrieves full message history for a specific chat session
 * @route GET /api/ai-assistant/sessions/:chatId
 */
export const getChatSessionById = async (req, res) => {
  try {
    const { chatId } = req.params;
    const ChatModel = getChatModel(req);
    const userId = req.user._id || req.user.id;

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ success: false, message: "Invalid chat session ID." });
    }

    const chat = await ChatModel.findOne({ _id: chatId, userId }).lean();

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat session not found." });
    }

    res.status(200).json({
      success: true,
      data: {
        id: chat._id.toString(),
        title: chat.title,
        messages: (chat.messages || []).map((m) => ({
          id: m._id?.toString(),
          role: m.role,
          content: m.content,
          toolsUsed: m.toolsUsed || [],
          timestamp: m.timestamp,
        })),
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      },
    });
  } catch (error) {
    console.error("[AI Assistant Controller] Error in getChatSessionById:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Deletes a specific chat session
 * @route DELETE /api/ai-assistant/sessions/:chatId
 */
export const deleteChatSession = async (req, res) => {
  try {
    const { chatId } = req.params;
    const ChatModel = getChatModel(req);
    const userId = req.user._id || req.user.id;

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ success: false, message: "Invalid chat session ID." });
    }

    const deleted = await ChatModel.findOneAndDelete({ _id: chatId, userId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Chat session not found." });
    }

    res.status(200).json({
      success: true,
      message: "Chat session deleted successfully.",
    });
  } catch (error) {
    console.error("[AI Assistant Controller] Error in deleteChatSession:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Clears all chat history for the user
 * @route DELETE /api/ai-assistant/sessions
 */
export const clearAllChatSessions = async (req, res) => {
  try {
    const ChatModel = getChatModel(req);
    const userId = req.user._id || req.user.id;

    await ChatModel.deleteMany({ userId });

    res.status(200).json({
      success: true,
      message: "All chat sessions cleared successfully.",
    });
  } catch (error) {
    console.error("[AI Assistant Controller] Error in clearAllChatSessions:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
