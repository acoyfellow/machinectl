const BASE_KEYS = ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER"];
const PROTECTED_PASSTHROUGH_KEYS = new Set(["MACHINECTL_ACCESS_TOKEN"]);

function passthroughKeys(variable: string): string[] {
  return (process.env[variable] ?? "").split(",").map((value) => value.trim()).filter((key) => key && !PROTECTED_PASSTHROUGH_KEYS.has(key));
}

export function childEnv(passthroughVariable: string, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_KEYS, ...passthroughKeys(passthroughVariable)]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
