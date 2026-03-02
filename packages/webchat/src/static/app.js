// SafeClaw WebChat Client
(function () {
  "use strict";

  const messagesEl = document.getElementById("messages");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  // Configuration — the SPA is served by the WebChat adapter,
  // but chat messages go to the gateway's /api/chat endpoint.
  // The gateway URL and auth token must be configured.
  const GATEWAY_URL = localStorage.getItem("safeclaw_gateway_url") || "/api/chat";
  const AUTH_TOKEN = localStorage.getItem("safeclaw_auth_token") || "";

  /**
   * Simple markdown rendering for chat messages.
   * Handles: bold, italic, inline code, code blocks.
   */
  function renderMarkdown(text) {
    // Escape HTML first
    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks: ```...```
    html = html.replace(/```([\s\S]*?)```/g, function (_m, code) {
      return "<pre><code>" + code.trim() + "</code></pre>";
    });

    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold: **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic: *...*
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    return html;
  }

  /**
   * Append a message to the chat display.
   */
  function addMessage(role, content) {
    var div = document.createElement("div");
    div.className = "message " + role;

    var senderEl = document.createElement("div");
    senderEl.className = "sender";
    senderEl.textContent = role === "user" ? "You" : "SafeClaw";
    div.appendChild(senderEl);

    var bodyEl = document.createElement("div");
    bodyEl.className = "body";
    bodyEl.innerHTML = renderMarkdown(content);
    div.appendChild(bodyEl);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return div;
  }

  /**
   * Show typing indicator.
   */
  function showTyping() {
    var div = document.createElement("div");
    div.className = "typing-indicator";
    div.id = "typing";
    div.textContent = "SafeClaw is thinking...";
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Remove typing indicator.
   */
  function hideTyping() {
    var el = document.getElementById("typing");
    if (el) el.remove();
  }

  /**
   * Send a message to the gateway API.
   */
  async function sendMessage(content) {
    var headers = { "Content-Type": "application/json" };
    if (AUTH_TOKEN) {
      headers["Authorization"] = "Bearer " + AUTH_TOKEN;
    }

    var response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        type: "chat",
        payload: { message: content },
      }),
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    return response.json();
  }

  /**
   * Handle form submission.
   */
  formEl.addEventListener("submit", function (e) {
    e.preventDefault();

    var content = inputEl.value.trim();
    if (!content) return;

    inputEl.value = "";
    inputEl.disabled = true;
    formEl.querySelector("button").disabled = true;

    addMessage("user", content);
    showTyping();

    sendMessage(content)
      .then(function (data) {
        hideTyping();
        var reply =
          typeof data.payload === "string"
            ? data.payload
            : typeof data.payload === "object" && data.payload !== null && "content" in data.payload
              ? data.payload.content
              : JSON.stringify(data.payload);
        addMessage("assistant", reply);
      })
      .catch(function (err) {
        hideTyping();
        addMessage("error", "Failed to send: " + err.message);
      })
      .finally(function () {
        inputEl.disabled = false;
        formEl.querySelector("button").disabled = false;
        inputEl.focus();
      });
  });

  // Show initial help message
  if (!AUTH_TOKEN) {
    addMessage(
      "assistant",
      "Welcome to **SafeClaw WebChat**.\n\nTo connect, set your gateway URL and auth token in localStorage:\n\n```\nlocalStorage.setItem('safeclaw_gateway_url', 'http://127.0.0.1:18789/api/chat');\nlocalStorage.setItem('safeclaw_auth_token', 'your-token-here');\n```\n\nThen reload the page."
    );
  }
})();
