import { Hono, type Context } from "hono";
import { accessMiddleware, type AccessIdentity } from "./auth";
import { MachineHost } from "./machine-host";

interface Env {
  CF_ACCESS_AUD: string;
  CF_ACCESS_ISS: string;
  MACHINE_HOST: DurableObjectNamespace<MachineHost>;
  AUDIT_KV?: KVNamespace;
}

type AppEnv = {
  Bindings: Env;
  Variables: { identity: AccessIdentity };
};

export { MachineHost } from "./machine-host";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true, name: "machinectl-relay" }));
app.use("/machinectl/*", accessMiddleware());

function machineHost(c: Context<AppEnv>) {
  const identity = c.get("identity");
  return c.env.MACHINE_HOST.get(c.env.MACHINE_HOST.idFromName(identity.email));
}

function internalRequest(c: Context<AppEnv>, path: string, includeBody = false) {
  const identity = c.get("identity");
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Machinectl-Identity-Email", identity.email);
  headers.set("X-Machinectl-Identity-Sub", identity.sub);
  return new Request(`http://internal${path}`, {
    method: c.req.method,
    headers,
    ...(includeBody ? { body: c.req.raw.body } : {}),
  });
}

app.get("/machinectl/connect", (c) => machineHost(c).fetch(internalRequest(c, "/connect")));
app.post("/machinectl/mcp", (c) => machineHost(c).fetch(internalRequest(c, "/mcp", true)));
app.get("/machinectl/status", (c) => machineHost(c).fetch("http://internal/status"));

export default app;
