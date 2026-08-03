import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type InstanceLockHolder = {
  pid: number;
  name: string;
  url: string;
  startedAt: string;
};

export type InstanceLock = {
  path: string;
  release: () => void;
};

export class InstanceLockedError extends Error {
  readonly holder: InstanceLockHolder;
  readonly lockPath: string;
  constructor(holder: InstanceLockHolder, lockPath: string) {
    super(
      `Another machinectl daemon already controls the identity "${holder.name}" at ${holder.url}.\n` +
        `That daemon has the process identifier ${holder.pid}. It started at ${holder.startedAt}.\n` +
        `Two daemons with one identity remove each other from the relay again and again. ` +
        `Each daemon then gives a different list of tools.\n` +
        `To continue, stop the other daemon, or give this daemon a different MACHINECTL_NAME.\n` +
        `Lock file: ${lockPath}`,
    );
    this.name = "InstanceLockedError";
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

export function instanceLockDirectory(): string {
  const stateHome = process.env.MACHINECTL_STATE_DIR
    || process.env.XDG_STATE_HOME
    || join(homedir(), ".local", "state");
  return join(stateHome, "machinectl", "locks");
}

export function instanceLockPath(name: string, url: string): string {
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48) || "machine";
  const scope = createHash("sha256").update(url.trim().toLowerCase()).digest("hex").slice(0, 12);
  return join(instanceLockDirectory(), `${safeName}.${scope}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): InstanceLockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<InstanceLockHolder>;
    if (typeof parsed?.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      name: typeof parsed.name === "string" ? parsed.name : "unknown",
      url: typeof parsed.url === "string" ? parsed.url : "unknown",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "an unknown time",
    };
  } catch {
    return undefined;
  }
}

export function acquireInstanceLock(name: string, url: string): InstanceLock {
  const path = instanceLockPath(name, url);
  mkdirSync(dirname(path), { recursive: true });
  const holder: InstanceLockHolder = { pid: process.pid, name, url, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify(holder) + "\n");
      closeSync(fd);
      return { path, release: () => releaseIfOwned(path) };
    } catch (err) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readHolder(path);
      if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        throw new InstanceLockedError(existing, path);
      }
      try { unlinkSync(path); } catch {}
    }
  }
  throw new Error(`machinectl could not get the single instance lock at ${path}.`);
}

function releaseIfOwned(path: string) {
  const existing = readHolder(path);
  if (existing && existing.pid !== process.pid) return;
  try { unlinkSync(path); } catch {}
}
