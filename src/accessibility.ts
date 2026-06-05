import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const AX_TIMEOUT_MS = 10_000;
const AX_RESULT_MAX_BYTES = 128 * 1024;
const AX_MAX_TEXT_LENGTH = 256;
const AX_MAX_NODES = 100;
const AX_CACHE_TTL_MS = 60_000;

type CachedElement = { token: string; at: number };
const elementCache = new Map<string, CachedElement>();

export type AccessibilityQuery = {
  op: "snapshot" | "find" | "focused" | "apps" | "windows";
  app?: string;
  window?: string;
  text?: string;
  role?: string;
  depth?: number;
  maxNodes?: number;
  limit?: number;
};

export type AccessibilityAction = {
  op: "activate" | "focus" | "press" | "setValue";
  elementId: string;
  value?: string;
};

function cleanupCache() {
  const cutoff = Date.now() - AX_CACHE_TTL_MS;
  for (const [id, value] of elementCache) if (value.at < cutoff) elementCache.delete(id);
}

function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+/g, " ").trim().slice(0, AX_MAX_TEXT_LENGTH) || undefined;
}

function runSwift(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/swift", ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`accessibility query timed out after ${AX_TIMEOUT_MS}ms`));
    }, AX_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(0, AX_RESULT_MAX_BYTES); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(0, AX_RESULT_MAX_BYTES); });
    child.on("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on("close", (code) => { clearTimeout(timer); if (!settled) { settled = true; code === 0 ? resolve(stdout) : reject(new Error(stderr || `accessibility helper failed with code ${code}`)); } });
  });
}

function swiftJson(value: unknown): string {
  return JSON.stringify(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function helperSource(query: AccessibilityQuery): string {
  return `import Cocoa
import ApplicationServices
import Foundation
let input = try! JSONSerialization.jsonObject(with: Data("${swiftJson(query)}".utf8)) as! [String: Any]
let op = input["op"] as? String ?? "snapshot"
let wantedApp = (input["app"] as? String ?? "").lowercased()
let wantedWindow = (input["window"] as? String ?? "").lowercased()
let wantedText = (input["text"] as? String ?? "").lowercased()
let wantedRole = (input["role"] as? String ?? "").lowercased()
let maxDepth = min(max(input["depth"] as? Int ?? 2, 0), 8)
let maxNodes = min(max(input["maxNodes"] as? Int ?? 100, 1), ${AX_MAX_NODES})
let limit = min(max(input["limit"] as? Int ?? 20, 1), 100)
var emitted = 0
var nodes: [[String: Any]] = []
func attr(_ e: AXUIElement, _ key: CFString) -> Any? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, key, &v) == .success ? v : nil }
func text(_ v: Any?) -> String? { (v as? String)?.replacingOccurrences(of: "\\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines) }
func bool(_ v: Any?) -> Bool? { v as? Bool }
func token(_ e: AXUIElement) -> String { String(describing: Unmanaged.passUnretained(e).toOpaque()) }
func node(_ e: AXUIElement, _ app: String, _ depth: Int) -> [String: Any]? {
  if emitted >= maxNodes { return nil }
  let role = text(attr(e, kAXRoleAttribute as CFString)) ?? ""
  let title = text(attr(e, kAXTitleAttribute as CFString))
  let value = text(attr(e, kAXValueAttribute as CFString))
  let description = text(attr(e, kAXDescriptionAttribute as CFString))
  let haystack = [role, title ?? "", value ?? "", description ?? ""].joined(separator: " ").lowercased()
  let out: [String: Any] = ["token": token(e), "role": role, "subrole": text(attr(e, kAXSubroleAttribute as CFString)) ?? "", "title": title ?? "", "value": value ?? "", "description": description ?? "", "enabled": bool(attr(e, kAXEnabledAttribute as CFString)) ?? false, "focused": bool(attr(e, kAXFocusedAttribute as CFString)) ?? false, "selected": bool(attr(e, kAXSelectedAttribute as CFString)) ?? false, "app": app]
  emitted += 1
  if op == "find" && (wantedRole.isEmpty || role.lowercased().contains(wantedRole)) && (wantedText.isEmpty || haystack.contains(wantedText)) { nodes.append(out) }
  if depth > 0, let children = attr(e, kAXChildrenAttribute as CFString) as? [Any] { for child in children { _ = node(child as! AXUIElement, app, depth - 1) } }
  return out
}
var error: NSDictionary? = nil
let script = NSAppleScript(source: "tell application \\\"System Events\\\" to get {name, unix id} of every application process")!
let result = script.executeAndReturnError(&error)
if error != nil { print("{\\\"op\\\":\\\"${query.op}\\\",\\\"nodes\\\":[]}"); exit(0) }
var apps: [(String, pid_t)] = []
if result.numberOfItems >= 2 { let names = result.atIndex(1)!; let pids = result.atIndex(2)!; for index in 1...min(names.numberOfItems, pids.numberOfItems) { let name = names.atIndex(index)?.stringValue ?? ""; let pid = pid_t(pids.atIndex(index)?.int32Value ?? 0); if pid > 0 { apps.append((name, pid)) } } }
for (name, pid) in apps {
  if !wantedApp.isEmpty && !name.lowercased().contains(wantedApp) { continue }
  let app = AXUIElementCreateApplication(pid)
  if op == "apps" { nodes.append(["token": token(app), "title": name, "app": name]); continue }
  if op == "windows", let windows = attr(app, kAXWindowsAttribute as CFString) as? [Any] { for raw in windows { let window = raw as! AXUIElement; let title = text(attr(window, kAXTitleAttribute as CFString)) ?? ""; if wantedWindow.isEmpty || title.lowercased().contains(wantedWindow) { nodes.append(["token": token(window), "title": title, "role": text(attr(window, kAXRoleAttribute as CFString)) ?? "", "app": name]); if nodes.count >= limit { break } } }; continue }
  if op == "focused", let raw = attr(app, kAXFocusedWindowAttribute as CFString) { let focused = raw as! AXUIElement; if let n = node(focused, name, maxDepth) { nodes = [n] }; break }
  if op == "snapshot" { if let n = node(app, name, maxDepth) { nodes.append(n) }; if nodes.count >= limit { break } }
  if op == "find" { _ = node(app, name, maxDepth); if nodes.count >= limit { break } }
}
print(String(data: try! JSONSerialization.data(withJSONObject: ["op": op, "nodes": Array(nodes.prefix(limit))]), encoding: .utf8)!)`;
}

export async function accessibilityQuery(query: AccessibilityQuery): Promise<string> {
  if (platform() !== "darwin") throw new Error("accessibility_query is currently implemented only on macOS");
  const raw = await runSwift(helperSource(query));
  const parsed = JSON.parse(raw) as { nodes?: Array<Record<string, unknown>> };
  cleanupCache();
  const register = (node: Record<string, unknown>) => {
    const id = randomUUID();
    const token = String(node.token ?? "");
    if (token) elementCache.set(id, { token, at: Date.now() });
    return { elementId: id, role: sanitizeText(node.role), subrole: sanitizeText(node.subrole), title: sanitizeText(node.title), value: sanitizeText(node.value), description: sanitizeText(node.description), enabled: typeof node.enabled === "boolean" ? node.enabled : undefined, focused: typeof node.focused === "boolean" ? node.focused : undefined, selected: typeof node.selected === "boolean" ? node.selected : undefined, app: sanitizeText(node.app) };
  };
  return JSON.stringify({ op: query.op, nodes: (parsed.nodes ?? []).map(register) }, null, 2);
}

export async function accessibilityAction(action: AccessibilityAction): Promise<string> {
  if (platform() !== "darwin") throw new Error("accessibility_action is currently implemented only on macOS");
  cleanupCache();
  const cached = elementCache.get(action.elementId);
  if (!cached) throw new Error("Unknown or expired accessibility elementId. Query again before acting.");
  const source = `import ApplicationServices\nlet token = "${swiftJson(cached.token)}"\nlet pointer = UnsafeRawPointer(bitPattern: UInt(token.replacingOccurrences(of: "0x", with: ""), radix: 16) ?? 0)!\nlet element = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue() as! AXUIElement\nlet op = "${swiftJson(action.op)}"\nif op == "activate" || op == "press" { if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success { exit(1) } } else if op == "focus" { if AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) != .success { exit(1) } } else if op == "setValue" { if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, "${swiftJson(action.value ?? "")}" as CFString) != .success { exit(1) } }\nprint("ok")`;
  await runSwift(source);
  return `Accessibility action completed: ${action.op}`;
}
