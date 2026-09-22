/*
 * Adds an "Ask Claude" / "ChatGPT" row to the MCP Agent panel, so you can start
 * a conversation without leaving the Adobe app.
 *
 * Injected into the adb-mcp CEP panels at build time — see build.sh. Uses CEP's
 * own APIs, so it needs nothing from the panel's own code.
 */
(function () {
  "use strict";

  var APP = (document.title || "this app").replace(/ MCP Agent$/, "");

  function openApp(name) {
    try {
      window.cep.process.createProcess("/usr/bin/open", "-a", name);
      return true;
    } catch (e) {
      return false;
    }
  }

  function openUrl(url) {
    try {
      window.cep.util.openURLInDefaultBrowser(url);
    } catch (e) {
      window.open(url, "_blank");
    }
  }

  var css = document.createElement("style");
  css.textContent = [
    ".mcp-ask{display:flex;gap:8px;margin:0 0 10px}",
    ".mcp-ask button{flex:1;padding:9px 6px;font-size:12px;font-weight:600;",
    "  border-radius:6px;border:1px solid #4a4a52;background:#2b2b31;color:#e8e8ec;",
    "  cursor:pointer;transition:.12s}",
    ".mcp-ask button:hover{background:#35353c;border-color:#666}",
    ".mcp-ask button.go{background:#d97757;border-color:#d97757;color:#fff}",
    ".mcp-ask button.go:hover{filter:brightness(1.1)}",
    ".mcp-hint{font-size:10.5px;line-height:1.45;color:#8a8a94;margin:0 0 6px}",
  ].join("");
  document.head.appendChild(css);

  var bar = document.createElement("div");
  bar.className = "mcp-ask";

  var claude = document.createElement("button");
  claude.className = "go";
  claude.textContent = "Ask Claude";
  claude.title = "Opens Claude, which can control " + APP;
  claude.onclick = function () {
    if (!openApp("Claude")) openUrl("https://claude.ai/new");
  };

  var gpt = document.createElement("button");
  gpt.textContent = "ChatGPT ↗";
  gpt.title = "Opens ChatGPT in your browser";
  gpt.onclick = function () { openUrl("https://chatgpt.com/"); };

  bar.appendChild(claude);
  bar.appendChild(gpt);

  var hint = document.createElement("p");
  hint.className = "mcp-hint";
  hint.textContent =
    "Claude can drive " + APP + " directly. ChatGPT opens in the browser — it " +
    "can't reach this app, so use it for ideas, not actions.";

  // Sit directly under the connection status, above the Connect button.
  var anchor = document.getElementById("btnConnect");
  var host = (anchor && anchor.parentNode) || document.querySelector(".container") || document.body;
  if (anchor) {
    host.insertBefore(bar, anchor);
    host.insertBefore(hint, anchor);
  } else {
    host.insertBefore(hint, host.firstChild);
    host.insertBefore(bar, host.firstChild);
  }
})();
