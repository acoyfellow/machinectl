import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PairedMachine {
  url: string;
  name: string;
  credential: string;
}

export const LAUNCH_AGENT_LABEL = "dev.machinectl.daemon";

export function configDir(): string {
  return process.env.MACHINECTL_CONFIG_DIR ?? join(homedir(), ".config", "machinectl");
}

export function pairedMachinePath(): string {
  return join(configDir(), "machine.json");
}

export function readPairedMachine(): PairedMachine | null {
  const path = pairedMachinePath();
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PairedMachine>;
  if (typeof value.url !== "string" || typeof value.name !== "string" || typeof value.credential !== "string") return null;
  return { url: value.url, name: value.name, credential: value.credential };
}

function writePairedMachine(machine: PairedMachine): string {
  const path = pairedMachinePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(machine, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export async function pairMachine(url: string, code: string, name: string, fetcher: typeof fetch = fetch): Promise<PairedMachine> {
  const base = url.replace(/\/+$/, "");
  const response = await fetcher(`${base}/machines/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; name?: string; credential?: string; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok || !body.name || !body.credential) {
    throw new Error(`Pairing failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const machine = { url: base, name: body.name, credential: body.credential };
  writePairedMachine(machine);
  return machine;
}

export function launchAgentPlist(nodePath: string, entryPath: string, logDir: string, env: Record<string, string>): string {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/caffeinate</string>
      <string>-is</string>
      <string>${escapeXml(nodePath)}</string>
      <string>${escapeXml(entryPath)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, "machinectl.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, "machinectl.err.log"))}</string>
  </dict>
</plist>
`;
}

export function writeLaunchAgent(plist: string, launchAgentsDir = join(homedir(), "Library", "LaunchAgents")): string {
  mkdirSync(launchAgentsDir, { recursive: true });
  const path = join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  writeFileSync(path, plist, { mode: 0o644 });
  return path;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
