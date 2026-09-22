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
    ".mcp-ask button.cog{flex:0 0 34px;font-size:14px}",
    ".mcp-hint{font-size:10.5px;line-height:1.45;color:#8a8a94;margin:0 0 6px}",
    ".mcp-guide{margin:0 0 10px;font-size:11px;color:#b4b4bc}",
    ".mcp-guide summary{cursor:pointer;color:#8a8a94;padding:3px 0;user-select:none}",
    ".mcp-guide summary:hover{color:#c8c8d0}",
    ".mcp-guide ol,.mcp-guide ul{margin:4px 0 6px;padding-left:16px;line-height:1.5}",
    ".mcp-guide li{margin:3px 0}",
    ".mcp-guide ul li{color:#9a9aa4;font-style:italic}",
    ".mcp-try{margin:6px 0 0;color:#8a8a94}",
    ".mcp-warn{margin:6px 0 0;color:#c9a227;line-height:1.45}",
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
  gpt.title = "Opens the ChatGPT desktop app, which can also control " + APP;
  gpt.onclick = function () {
    if (!openApp("ChatGPT")) openUrl("https://chatgpt.com/");
  };

  var settings = document.createElement("button");
  settings.className = "cog";
  settings.textContent = "\u2699";
  settings.title = "Open the Adobe MCP control panel";
  settings.onclick = function () { openUrl("http://localhost:3001/"); };

  bar.appendChild(claude);
  bar.appendChild(gpt);
  bar.appendChild(settings);

  var hint = document.createElement("p");
  hint.className = "mcp-hint";
  hint.textContent =
    "Both can drive " + APP + " — use the desktop apps. A ChatGPT browser tab " +
    "can't reach it.";

  // --- quick guide -------------------------------------------------------
  var EXAMPLES = {
    "Illustrator": [
      "Make a 1080\u00d71920 story with a bold headline",
      "Recolour everything to our brand palette",
      "Rename every layer to a consistent format"
    ],
    "After Effects": [
      "Create a 5 second comp and fade the title in",
      "Add motion blur to the selected layer",
      "Add this comp to the render queue"
    ],
    "Premiere Pro": [
      "Build a rough cut from these clips with cross dissolves",
      "Add a marker every time the speaker changes",
      "Mute the music track"
    ],
    "Photoshop": [
      "Make an Instagram post that looks like a Polaroid",
      "Rename every layer to a consistent format",
      "Export this at 2\u00d7"
    ],
    "InDesign": [
      "Make a 3 page A4 layout using our paragraph styles",
      "Flow this text into the existing frames"
    ]
  };

  var guide = document.createElement("details");
  guide.className = "mcp-guide";
  var tries = (EXAMPLES[APP] || ["Describe what you want, in plain words"])
    .map(function (t) { return "<li>\u201c" + t + "\u201d</li>"; }).join("");
  guide.innerHTML =
    "<summary>How to use this</summary>" +
    "<ol>" +
      "<li>Leave this panel open \u2014 it\u2019s the connection.</li>" +
      "<li>Press <b>Ask Claude</b> or <b>ChatGPT</b> above.</li>" +
      "<li>Say what you want in plain words. It works on the document you have open.</li>" +
    "</ol>" +
    "<p class=\"mcp-try\">Try asking:</p><ul>" + tries + "</ul>" +
    "<p class=\"mcp-warn\">Save first. It edits your open document, and not every " +
    "step can be undone.</p>";

  // Sit directly under the connection status, above the Connect button.
  var anchor = document.getElementById("btnConnect");
  var host = (anchor && anchor.parentNode) || document.querySelector(".container") || document.body;
  if (anchor) {
    host.insertBefore(bar, anchor);
    host.insertBefore(hint, anchor);
    host.insertBefore(guide, anchor);
  } else {
    host.insertBefore(guide, host.firstChild);
    host.insertBefore(hint, host.firstChild);
    host.insertBefore(bar, host.firstChild);
  }
})();
