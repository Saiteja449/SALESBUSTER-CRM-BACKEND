(function () {
  if (window.SalesBusterChatWidgetInitialized) return;
  window.SalesBusterChatWidgetInitialized = true;

  // Detect script source to resolve API base URL
  let apiBase = "";
  const currentScript =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]') ||
    document.querySelector('script[data-api]');

  if (currentScript && currentScript.getAttribute("data-api")) {
    apiBase = currentScript.getAttribute("data-api").replace(/\/$/, "");
  } else if (currentScript && currentScript.src) {
    try {
      const url = new URL(currentScript.src);
      apiBase = url.origin;
    } catch (e) {
      apiBase = "";
    }
  }

  // Session ID management via localStorage
  const SESSION_KEY = "salesbuster_chat_session_id";
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = "sb_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  // Inject Styles
  const style = document.createElement("style");
  style.id = "salesbuster-widget-styles";
  style.textContent = `
    .sb-widget-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5 0%, #3730a3 100%);
      box-shadow: 0 10px 25px -5px rgba(79, 70, 229, 0.5), 0 8px 10px -6px rgba(79, 70, 229, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      border: none;
      outline: none;
    }
    .sb-widget-launcher:hover {
      transform: scale(1.08) translateY(-2px);
      box-shadow: 0 15px 30px -5px rgba(79, 70, 229, 0.6);
    }
    .sb-widget-launcher:active {
      transform: scale(0.96);
    }
    .sb-widget-launcher svg {
      width: 28px;
      height: 28px;
      fill: #ffffff;
      transition: transform 0.25s ease;
    }
    .sb-launcher-dot {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #10b981;
      border: 2px solid #ffffff;
    }

    .sb-widget-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 380px;
      height: 590px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px);
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.18), 0 0 1px 1px rgba(0, 0, 0, 0.05);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      opacity: 0;
      transform: translateY(16px) scale(0.96);
      pointer-events: none;
    }
    .sb-widget-window.sb-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    .sb-header {
      background: linear-gradient(135deg, #4f46e5 0%, #312e81 100%);
      color: #ffffff;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .sb-header-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .sb-header-avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      border: 1.5px solid rgba(255, 255, 255, 0.3);
    }
    .sb-header-title {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      line-height: 1.2;
    }
    .sb-header-status {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.8);
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 3px;
    }
    .sb-status-indicator {
      width: 7px;
      height: 7px;
      background: #10b981;
      border-radius: 50%;
      display: inline-block;
    }
    .sb-header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sb-icon-btn {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.8);
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, color 0.2s;
    }
    .sb-icon-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }

    .sb-messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f8fafc;
    }
    .sb-message {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13.5px;
      line-height: 1.5;
      word-break: break-word;
      animation: sbFadeIn 0.2s ease;
    }
    @keyframes sbFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .sb-message.sb-user {
      align-self: flex-end;
      background: #4f46e5;
      color: #ffffff;
      border-bottom-right-radius: 3px;
    }
    .sb-message.sb-bot {
      align-self: flex-start;
      background: #ffffff;
      color: #1e293b;
      border-bottom-left-radius: 3px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
      border: 1px solid #e2e8f0;
    }
    .sb-message.sb-bot p {
      margin: 0 0 6px 0;
    }
    .sb-message.sb-bot p:last-child {
      margin-bottom: 0;
    }
    .sb-message.sb-bot ul {
      margin: 4px 0 6px 18px;
      padding: 0;
    }
    .sb-message.sb-bot li {
      margin-bottom: 4px;
    }

    .sb-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .sb-chip {
      background: #ffffff;
      border: 1px solid #c7d2fe;
      color: #4338ca;
      padding: 6px 10px;
      border-radius: 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .sb-chip:hover {
      background: #e0e7ff;
      border-color: #818cf8;
    }

    .sb-typing {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 14px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      border-bottom-left-radius: 3px;
      align-self: flex-start;
      width: fit-content;
    }
    .sb-typing span {
      width: 6px;
      height: 6px;
      background: #94a3b8;
      border-radius: 50%;
      animation: sbBounce 1.4s infinite ease-in-out both;
    }
    .sb-typing span:nth-child(1) { animation-delay: -0.32s; }
    .sb-typing span:nth-child(2) { animation-delay: -0.16s; }
    @keyframes sbBounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }

    .sb-footer {
      padding: 12px 14px;
      background: #ffffff;
      border-top: 1px solid #e2e8f0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sb-input-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sb-input {
      flex: 1;
      padding: 10px 14px;
      border-radius: 24px;
      border: 1px solid #cbd5e1;
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .sb-input:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.15);
    }
    .sb-send-btn {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #4f46e5;
      color: #ffffff;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s, transform 0.15s;
    }
    .sb-send-btn:hover {
      background: #4338ca;
      transform: scale(1.05);
    }
    .sb-send-btn:active {
      transform: scale(0.95);
    }
    .sb-send-btn:disabled {
      background: #cbd5e1;
      cursor: not-allowed;
      transform: none;
    }
    .sb-brand {
      text-align: center;
      font-size: 11px;
      color: #94a3b8;
    }
    .sb-brand a {
      color: #6366f1;
      text-decoration: none;
      font-weight: 500;
    }
  `;
  document.head.appendChild(style);

  // Inject HTML Elements
  const launcher = document.createElement("button");
  launcher.className = "sb-widget-launcher";
  launcher.setAttribute("aria-label", "Chat with SalesBuster AI");
  launcher.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
    </svg>
    <div class="sb-launcher-dot"></div>
  `;

  const chatWindow = document.createElement("div");
  chatWindow.className = "sb-widget-window";
  chatWindow.innerHTML = `
    <div class="sb-header">
      <div class="sb-header-info">
        <div class="sb-header-avatar">SB</div>
        <div>
          <h3 class="sb-header-title">SalesBuster AI</h3>
          <div class="sb-header-status">
            <span class="sb-status-indicator"></span> Instant Knowledge Base
          </div>
        </div>
      </div>
      <div class="sb-header-actions">
        <button class="sb-icon-btn sb-reset-btn" title="New Chat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
        </button>
        <button class="sb-icon-btn sb-close-btn" title="Close Chat">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="sb-messages-container" id="sb-messages">
      <div class="sb-message sb-bot">
        Hello! 👋 I'm your <strong>SalesBuster AI</strong> assistant. Ask me anything about our CRM platform, pricing, call recording, WhatsApp automations, or features!
      </div>
      <div class="sb-chips">
        <button class="sb-chip" data-query="How much does SalesBuster cost?">💰 Pricing & Plans</button>
        <button class="sb-chip" data-query="What features are included in SalesBuster CRM?">⚡ Core Features</button>
        <button class="sb-chip" data-query="How does call recording and AI transcription work?">📞 Call Recording</button>
        <button class="sb-chip" data-query="How does omnichannel lead capture work?">🎯 Lead Capture</button>
      </div>
    </div>

    <div class="sb-footer">
      <div class="sb-input-row">
        <input type="text" class="sb-input" id="sb-input" placeholder="Ask anything about SalesBuster..." autocomplete="off"/>
        <button class="sb-send-btn" id="sb-send" title="Send Message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
      <div class="sb-brand">Powered by <a href="https://salesbuster.ai" target="_blank">SalesBuster.ai</a></div>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(chatWindow);

  // Elements
  const messagesEl = document.getElementById("sb-messages");
  const inputEl = document.getElementById("sb-input");
  const sendBtn = document.getElementById("sb-send");
  const closeBtn = chatWindow.querySelector(".sb-close-btn");
  const resetBtn = chatWindow.querySelector(".sb-reset-btn");

  let isOpen = false;
  let isSubmitting = false;

  const toggleChat = () => {
    isOpen = !isOpen;
    if (isOpen) {
      chatWindow.classList.add("sb-open");
      launcher.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      `;
      setTimeout(() => inputEl.focus(), 150);
    } else {
      chatWindow.classList.remove("sb-open");
      launcher.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
        <div class="sb-launcher-dot"></div>
      `;
    }
  };

  launcher.addEventListener("click", toggleChat);
  closeBtn.addEventListener("click", toggleChat);

  // Markdown Formatter helper
  const formatMarkdown = (text) => {
    if (!text) return "";
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    // Bullet points
    html = html.replace(/^\s*[-•]\s+(.*)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
    // Line breaks
    html = html.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br/>");
    return `<p>${html}</p>`;
  };

  const appendMessage = (text, sender = "bot") => {
    const msgDiv = document.createElement("div");
    msgDiv.className = `sb-message sb-${sender}`;
    if (sender === "bot") {
      msgDiv.innerHTML = formatMarkdown(text);
    } else {
      msgDiv.textContent = text;
    }
    messagesEl.appendChild(msgDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const showTyping = () => {
    const typingDiv = document.createElement("div");
    typingDiv.className = "sb-typing";
    typingDiv.id = "sb-typing-indicator";
    typingDiv.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(typingDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const hideTyping = () => {
    const indicator = document.getElementById("sb-typing-indicator");
    if (indicator) indicator.remove();
  };

  // Send message
  const handleSend = async (userText) => {
    const text = (userText || inputEl.value || "").trim();
    if (!text || isSubmitting) return;

    inputEl.value = "";
    appendMessage(text, "user");

    // Remove chips if present
    const chips = messagesEl.querySelector(".sb-chips");
    if (chips) chips.remove();

    isSubmitting = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const endpoint = (apiBase || "") + "/api/static-chat";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: sessionId,
        }),
      });

      if (!res.ok) {
        throw new Error("Server response error: " + res.status);
      }

      const data = await res.json();
      hideTyping();
      appendMessage(data.reply || "No reply generated.");

      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem(SESSION_KEY, sessionId);
      }
    } catch (err) {
      hideTyping();
      appendMessage("Sorry, I had trouble connecting. Please try again in a few moments.");
      console.error("[SalesBuster Chat Error]:", err);
    } finally {
      isSubmitting = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  };

  sendBtn.addEventListener("click", () => handleSend());
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Suggestion chips handler
  messagesEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("sb-chip")) {
      const query = e.target.getAttribute("data-query");
      if (query) handleSend(query);
    }
  });

  // Reset chat
  resetBtn.addEventListener("click", async () => {
    if (confirm("Start a new conversation?")) {
      try {
        const endpoint = (apiBase || "") + "/api/static-chat/reset";
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch (e) {}

      sessionId = "sb_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      localStorage.setItem(SESSION_KEY, sessionId);

      messagesEl.innerHTML = `
        <div class="sb-message sb-bot">
          Chat cleared! How can I help you with SalesBuster today?
        </div>
        <div class="sb-chips">
          <button class="sb-chip" data-query="How much does SalesBuster cost?">💰 Pricing & Plans</button>
          <button class="sb-chip" data-query="What features are included in SalesBuster CRM?">⚡ Core Features</button>
          <button class="sb-chip" data-query="How does call recording and AI transcription work?">📞 Call Recording</button>
          <button class="sb-chip" data-query="How does omnichannel lead capture work?">🎯 Lead Capture</button>
        </div>
      `;
    }
  });
})();
