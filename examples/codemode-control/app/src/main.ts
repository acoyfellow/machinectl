import "./style.css";

type PublishedTool = { name: string; description: string };
type Status = { connected: boolean; machineName: string | null; tools: PublishedTool[] };
type CallResult = { ok: boolean; kind?: string; content?: string; error?: string };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

const toolGroups = {
  core: ["shell", "screenshot", "mouse", "keyboard"],
  diagnostic: ["local_auth_status"],
  agents: ["harness_catalog", "harness_start", "harness_list", "harness_status", "harness_prompt", "harness_steer", "harness_control", "harness_stop"],
};

function controls() {
  return `
    <div class="buttons"><button data-action="status">Auth health</button><button data-action="screenshot">Screenshot</button></div>
    <div class="shell-line"><span>›</span><input id="shell-command" value="pwd" aria-label="Shell command"/><button id="run-shell">Run</button></div>
    <pre id="output">Ready.</pre><img id="screen" alt="Laptop screenshot" hidden />`;
}
function codePanel() {
  return `<textarea id="code-input" class="code-input" aria-label="Code Mode test">async () => {
  const shot = await codemode.screenshot({});
  return shot;
}</textarea><div class="buttons"><button id="run-code">Execute isolated code</button></div>`;
}
function endpoint() { return `<div class="mcp-row"><code id="mcp-url"></code><button id="copy-mcp">Copy MCP URL</button></div>`; }
function cards() {
  return `<section class="grid">
    <article class="card machine"><div class="card-title">Connected machine</div><h2 id="machine-name">Waiting…</h2><div id="caps" class="caps"></div><p class="warning">Authorized access is terminal-and-desktop-equivalent. Code Mode isolates orchestration, not authority.</p></article>
    <article class="card proof"><div class="card-title">Direct proof</div>${controls()}</article>
    <article class="card code"><div class="card-title">Agent-facing default</div><h2>One tool: <code>code</code></h2>${codePanel()}<p>Isolated Dynamic Worker. No ambient outbound network.</p></article>
    <article class="card pi"><div class="card-title">Delegated agents</div><h2>Live local sessions</h2><p id="harness-copy">Checking…</p><pre class="snippet">harness_start → prompt → steer → status → stop</pre></article>
  </section>`;
}
app.innerHTML = `<header class="bar"><div class="brand"><span class="mark">⌂</span> machinectl</div><div class="badge" id="status-badge"><span class="dot"></span><span id="status-label">checking</span></div></header><main><section class="hero"><p class="eyebrow">SECURE REMOTE COMPUTER CONTROL</p><h1>Control your computer<br><span>from any device.</span></h1><p class="lead">Your computer connects outbound through Cloudflare Access. Securely use shell, screen, keyboard, mouse, and optional delegated-agent control from your phone, browser, or agent.</p>${endpoint()}</section>${cards()}</main>`;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);
const output = $("#output") as HTMLElement | null;
const screen = $("#screen") as HTMLImageElement | null;
let status: Status = { connected: false, machineName: null, tools: [] };
const mcp = $("#mcp-url"); if (mcp) mcp.textContent = `${location.origin}/mcp`;
$("#copy-mcp")?.addEventListener("click", async () => {
  const button = $("#copy-mcp")!;
  try { await navigator.clipboard.writeText(`${location.origin}/mcp`); button.textContent = "Copied"; }
  catch { button.textContent = "Copy failed"; }
  setTimeout(() => { button.textContent = "Copy MCP URL"; }, 1200);
});
function includes(name: string) { return status.tools.some((tool) => tool.name === name); }
function renderStatus() {
  const badge = $("#status-badge"); if (badge) badge.dataset.online = String(status.connected);
  const label = $("#status-label"); if (label) label.textContent = status.connected ? "online" : "offline";
  const name = $("#machine-name"); if (name) name.textContent = status.connected ? status.machineName || "connected" : "offline";
  const caps = $("#caps"); if (caps) { caps.innerHTML = ""; for (const [group, names] of Object.entries(toolGroups)) if (names.some(includes)) { const pill = document.createElement("span"); pill.textContent = group; pill.className = "pill"; caps.appendChild(pill); } }
  const harness = $("#harness-copy"); if (harness) harness.textContent = includes("harness_start") ? "Enabled · live sessions ready" : "Unavailable";
  document.querySelectorAll<HTMLButtonElement>("button[data-action], #run-shell, #run-code").forEach((element) => { element.disabled = !status.connected; });
}
async function refresh() { status = await fetch("/api/status").then((response) => response.json()); renderStatus(); }
async function present(result: CallResult, imageLabel: string) { if (!output) return; if (!result.ok) { output.textContent = result.error || "Failed"; return; } if (result.content?.startsWith("data:image/") || (result.kind === "image" && result.content)) { if (screen) { screen.src = result.content!; screen.hidden = false; } output.textContent = imageLabel; return; } if (screen) screen.hidden = true; output.textContent = result.content || "(empty result)"; }
async function call(tool: string, args: Record<string, unknown> = {}) { if (output) output.textContent = "Calling…"; const result = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, arguments: args }) }).then((response) => response.json()) as CallResult; await present(result, "Screenshot received."); }
$("[data-action=status]")?.addEventListener("click", () => call("local_auth_status"));
$("[data-action=screenshot]")?.addEventListener("click", () => call("screenshot"));
$("#run-shell")?.addEventListener("click", () => call("shell", { command: ($("#shell-command") as HTMLInputElement).value }));
$("#shell-command")?.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") $("#run-shell")?.click(); });
$("#run-code")?.addEventListener("click", async () => { if (output) output.textContent = "Executing…"; const code = ($("#code-input") as HTMLTextAreaElement).value; const result = await fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).then((response) => response.json()) as CallResult; await present(result, "Code Mode screenshot received."); });
refresh().catch((error) => { if (output) output.textContent = String(error); });
setInterval(() => refresh().catch(() => undefined), 5000);
