import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configDir,
  LAUNCH_AGENT_LABEL,
  launchAgentPlist,
  logOutMachine,
  MACHINE_NAME_PATTERN,
  readMachineConfig,
  writeLaunchAgent,
  writeMachineConfig,
} from "./pairing.js";

const USAGE = `usage:
  machinectl                                    run the daemon
  machinectl install-agent --url <my-ax url> [--name <name>] [--shell]
                                                sign this computer in and start it at login
  machinectl logout <name> [--url <my-ax url>]  log another machine out (it stays out until you allow it in my-ax)
  machinectl stop                               stop this machine's daemon and keep it off

  Sign in first with: cloudflared access login <my-ax url>
  A new machine waits for your approval in my-ax under Settings > Connections.
  --shell lets the agent run terminal commands in your home folder.`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function defaultMachineName(host = hostname()): string {
  return host.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "mac";
}

export function launchAgentEnv(shell: boolean): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    MACHINECTL_ENABLE_HAND: "1",
    MACHINECTL_LOG_TIMESTAMP: "1",
  };
  for (const key of ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (shell) Object.assign(env, { MACHINECTL_ENABLE_SHELL: "1", MACHINECTL_ALLOWED_PATHS: homedir() });
  return env;
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function installLaunchAgent(shell: boolean): string {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const plist = launchAgentPlist(process.execPath, entry, configDir(), launchAgentEnv(shell));
  const path = writeLaunchAgent(plist);
  if (process.platform === "darwin") {
    try { execFileSync("launchctl", ["unload", path], { stdio: "ignore" }); } catch {}
    execFileSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
  }
  return path;
}

export function stopLaunchAgent(path = launchAgentPath()): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "darwin") {
    try { execFileSync("launchctl", ["unload", "-w", path], { stdio: "ignore" }); } catch {}
  }
  rmSync(path);
  return true;
}

function accessToken(url: string): string | null {
  try {
    const token = execFileSync("cloudflared", ["access", "token", `--app=${url}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function runCommand(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  if (!command) return null;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "install-agent") {
    const url = flag(rest, "--url") ?? readMachineConfig()?.url ?? process.env.MACHINECTL_URL;
    const name = (flag(rest, "--name") ?? readMachineConfig()?.name ?? defaultMachineName()).toLowerCase();
    if (!url || !MACHINE_NAME_PATTERN.test(name)) {
      console.error(USAGE);
      return 2;
    }
    if (!accessToken(url)) {
      console.error(`[machinectl] sign in first: cloudflared access login ${url}`);
      return 1;
    }
    writeMachineConfig({ url, name });
    console.log(`[machinectl] this machine is "${name}" on ${url}`);
    console.log(`[machinectl] launch agent installed: ${installLaunchAgent(rest.includes("--shell"))}`);
    console.log("[machinectl] approve it in my-ax under Settings > Connections. Until then it has no access.");
    return 0;
  }
  if (command === "logout") {
    const name = rest[0]?.toLowerCase();
    const url = flag(rest, "--url") ?? readMachineConfig()?.url ?? process.env.MACHINECTL_URL;
    if (!name || !MACHINE_NAME_PATTERN.test(name) || !url) {
      console.error(USAGE);
      return 2;
    }
    const token = accessToken(url);
    if (!token) {
      console.error(`[machinectl] sign in first: cloudflared access login ${url}`);
      return 1;
    }
    try {
      await logOutMachine(url, name, token);
    } catch (error) {
      console.error(`[machinectl] ${(error as Error).message}`);
      return 1;
    }
    console.log(`[machinectl] "${name}" is logged out. Allow it again in my-ax to let it back in.`);
    return 0;
  }
  if (command === "stop") {
    console.log(stopLaunchAgent() ? "[machinectl] stopped and removed from login items" : "[machinectl] no launch agent was installed");
    return 0;
  }
  console.error(`unknown command: ${command}\n${USAGE}`);
  return 2;
}
