import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { configDir, launchAgentPlist, pairMachine, writeLaunchAgent } from "./pairing.js";

const USAGE = `usage:
  machinectl                                   run the daemon
  machinectl pair <code> --url <my-ax url> [--name <name>] [--shell] [--no-agent]
                                               pair this computer and start it at login
  machinectl install-agent [--shell]           (re)install the macOS launch agent

  --shell lets the agent run terminal commands in your home folder.`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultMachineName(): string {
  return hostname().toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 63) || "mac";
}

export function launchAgentEnv(shell: boolean): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    MACHINECTL_ENABLE_HAND: "1",
  };
  if (shell) Object.assign(env, { MACHINECTL_ENABLE_SHELL: "1", MACHINECTL_ALLOWED_PATHS: homedir() });
  return env;
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

export async function runCommand(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  if (!command) return null;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "pair") {
    const code = rest[0];
    const url = flag(rest, "--url") ?? process.env.MACHINECTL_URL;
    if (!code || code.startsWith("--") || !url) {
      console.error(USAGE);
      return 2;
    }
    const machine = await pairMachine(url, code, flag(rest, "--name") ?? defaultMachineName()).catch((error: Error) => {
      console.error(`[machinectl] ${error.message}`);
      return null;
    });
    if (!machine) return 1;
    console.log(`[machinectl] paired as "${machine.name}" with ${machine.url}`);
    if (rest.includes("--no-agent")) return 0;
    console.log(`[machinectl] launch agent installed: ${installLaunchAgent(rest.includes("--shell"))}`);
    console.log("[machinectl] grant Screen Recording and Accessibility to node in System Settings once, so screen and app tools work");
    return 0;
  }
  if (command === "install-agent") {
    console.log(`[machinectl] launch agent installed: ${installLaunchAgent(rest.includes("--shell"))}`);
    return 0;
  }
  console.error(`unknown command: ${command}\n${USAGE}`);
  return 2;
}

