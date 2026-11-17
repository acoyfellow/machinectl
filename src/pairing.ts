import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MachineConfig {
  url: string;
  name: string;
}

export const LAUNCH_AGENT_LABEL = "dev.machinectl.daemon";
export const MACHINE_LOGGED_OUT_CLOSE_CODE = 4401;
export const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function configDir(): string {
  return process.env.MACHINECTL_CONFIG_DIR ?? join(homedir(), ".config", "machinectl");
}

export function machineConfigPath(): string {
  return join(configDir(), "machine.json");
}

export function readMachineConfig(): MachineConfig | null {
  const path = machineConfigPath();
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MachineConfig>;
  if (typeof value.url !== "string" || typeof value.name !== "string" || !MACHINE_NAME_PATTERN.test(value.name)) return null;
  return { url: value.url.replace(/\/+$/, ""), name: value.name };
}

export function writeMachineConfig(machine: MachineConfig): string {
  const path = machineConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ url: machine.url.replace(/\/+$/, ""), name: machine.name }, null, 2), { mode: 0o600 });
  return path;
}

export function machineConnectUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "").replace(/^http(s?):/, "ws$1:")}/machinectl/connect?machine=${encodeURIComponent(name)}`;
}

export function refusalIsFinal(status: number, stateHeader: string | undefined): boolean {
  return status === 403 && (stateHeader === "pending" || stateHeader === "logged_out");
}

export async function logOutMachine(base: string, name: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`${base.replace(/\/+$/, "")}/api/machines/${encodeURIComponent(name)}/logout`, {
    method: "POST",
    headers: { "cf-access-token": accessToken },
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
  if (!response.ok || !body?.ok) throw new Error(`Log out failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
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
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
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
