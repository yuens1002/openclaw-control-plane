import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const suffix = `${process.pid}-${Date.now()}`;
const network = `runtime-verify-${suffix}`;
const postgres = `runtime-postgres-${suffix}`;
const issuerContainer = `runtime-issuer-${suffix}`;
const api = `runtime-api-${suffix}`;
const certVolume = `runtime-certs-${suffix}`;
const image = process.env.RUNTIME_VERIFY_IMAGE ?? "openclaw-decision-runtime:conformance";
const apiPort = process.env.RUNTIME_VERIFY_API_PORT
  ? Number(process.env.RUNTIME_VERIFY_API_PORT)
  : await freePort();
const postgresPort = process.env.RUNTIME_VERIFY_POSTGRES_PORT
  ? Number(process.env.RUNTIME_VERIFY_POSTGRES_PORT)
  : await freePort();
const issuer = "https://runtime-issuer:8443";
const databaseUrl = `postgresql://openclaw:openclaw@runtime-postgres:5432/openclaw_control_plane`;
const hostDatabaseUrl = `postgresql://openclaw:openclaw@localhost:${postgresPort}/openclaw_control_plane`;
const restoreDatabaseUrl = `postgresql://openclaw:openclaw@localhost:${postgresPort}/recovery_restore`;

const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "runtime-verify-key", alg: "RS256", use: "sig" };
const authConfig = {
  config_version: 1,
  issuers: [
    {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      audiences: ["control-plane"],
      allowed_algorithms: ["RS256"],
      clock_skew_seconds: 5
    }
  ],
  principals: [
    {
      issuer,
      subject: "runtime-verifier",
      principal_id: "principal://example/runtime-verifier",
      actor: { type: "service", id: "runtime-verifier" },
      roles: ["runtime.verifier"]
    }
  ],
  roles: [
    {
      name: "runtime.verifier",
      grants: [
        { authorization_action: "runtime.event.ingest", resources: [{ type: "example.environment", id: "*" }] },
        { authorization_action: "runtime.work-item.create", resources: [{ type: "example.environment", id: "*" }] },
        { authorization_action: "state.reconcile", resources: [{ type: "example.environment", id: "*" }] },
        {
          authorization_action: "runtime.record.read",
          resources: [
            { type: "runtime.record", id: "*" },
            { type: "runtime.stream", id: "*" },
            { type: "runtime.projection", id: "*" },
            { type: "runtime.audit", id: "*" },
            { type: "runtime.registry", id: "*" }
          ]
        }
      ]
    }
  ],
  delegations: [],
  authorization_policy: { provider: "static-rbac-v1", policy_version: "verify-v1" }
};
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
  .setIssuer(issuer)
  .setSubject("runtime-verifier")
  .setAudience("control-plane")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(privateKey);
try {
  if (process.env.RUNTIME_VERIFY_SKIP_BUILD !== "true") {
    docker("build", "-q", "-f", "deploy/decision-runtime/Dockerfile", "-t", image, ".");
  }
  docker("network", "create", network);
  docker("volume", "create", certVolume);
  docker(
    "run", "--rm", "-v", `${certVolume}:/certs`, "node:22-alpine", "sh", "-c",
    "apk add --no-cache openssl >/dev/null && openssl req -x509 -newkey rsa:2048 -nodes -keyout /certs/key.pem -out /certs/cert.pem -days 1 -subj /CN=runtime-issuer -addext subjectAltName=DNS:runtime-issuer"
  );
  docker(
    "run", "-d", "--rm", "--name", issuerContainer, "--network", network,
    "--network-alias", "runtime-issuer", "-e", `JWKS_JSON=${JSON.stringify({ keys: [publicJwk] })}`,
    "-v", `${certVolume}:/certs:ro`, "node:22-alpine", "node", "-e",
    "const fs=require('fs'),https=require('https');https.createServer({key:fs.readFileSync('/certs/key.pem'),cert:fs.readFileSync('/certs/cert.pem')},(req,res)=>{if(req.url==='/jwks'){res.writeHead(200,{'content-type':'application/json'});res.end(process.env.JWKS_JSON)}else{res.writeHead(404).end()}}).listen(8443,'0.0.0.0')"
  );
  docker(
    "run", "-d", "--rm", "--name", postgres, "--network", network,
    "--network-alias", "runtime-postgres", "-p", `127.0.0.1:${postgresPort}:5432`,
    "-e", "POSTGRES_USER=openclaw", "-e", "POSTGRES_PASSWORD=openclaw",
    "-e", "POSTGRES_DB=openclaw_control_plane", "postgres:16-alpine"
  );
  await waitFor(() => docker("exec", postgres, "pg_isready", "-U", "openclaw"), "PostgreSQL");
  startApi();
  await waitForHealth();

  const eventId = "00000000-0000-4000-8000-000000007001";
  const workId = "00000000-0000-4000-8000-000000007002";
  await request("/v1/runtime/events", {
    method: "POST",
    body: {
      record_id: eventId,
      stream_id: "verify-stream",
      type: "example.observation",
      schema_version: 1,
      subject: target(),
      payload: { statement: "Container verification observation." },
      source_refs: []
    },
    expected: 202
  });
  await request("/v1/runtime/work-items", {
    method: "POST",
    body: {
      record_id: workId,
      stream_id: "verify-stream",
      type: "example.state.reconcile",
      schema_version: 1,
      subject: target(),
      payload: { requested_state: { ready: true } },
      source_refs: [{ kind: "event", id: eventId }]
    },
    expected: 202
  });
  const command = {
    stream_id: "verify-stream",
    idempotency_key: "verify-command-1",
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: workId,
    action_revision: 1,
    target: target(),
    arguments: { desired: { ready: true } },
    declared_effects: [
      {
        kind: "result",
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/reconciliation-delta/v1",
        target: target(),
        payload: { changed: true }
      }
    ],
    trigger: { type: "user_request", ref: { kind: "work_item", id: workId } },
    causation_ref: { kind: "work_item", id: workId },
    correlation_id: "verify-correlation-1",
    input_refs: [{ kind: "event", id: eventId }]
  };
  const execution = await request("/v1/runtime/commands", {
    method: "POST",
    body: command,
    headers: { "x-tool-invocation-id": "verify-tool-1" },
    expected: 202
  });
  await request(`/v1/runtime/records/${execution.operation_record_id}`, { expected: 200 });
  await request(`/v1/runtime/records/${execution.operation_record_id}/edges`, { expected: 200 });

  const { initializePostgresRuntime } = await import("../packages/db/dist/index.js");
  let runtime = await initializePostgresRuntime(hostDatabaseUrl);
  await runtime.repository.rebuildProjection({
    stream_id: "verify-stream",
    projection_type: "example.current",
    subject: target(),
    projection_version: 1,
    input_types: [{ kind: "result", type: "example.reconciliation.delta", schema_version: 1 }],
    initial_state: { changed: false },
    reduce: (_state, record) => record.payload
  });
  await runtime.close();
  await request(
    "/v1/runtime/projections/example.current/example.environment/production?stream_id=verify-stream&projection_version=1",
    { expected: 200 }
  );

  docker("stop", api);
  startApi();
  await waitForHealth();
  await request("/v1/runtime/streams/verify-stream/records", { expected: 200 });
  await request("/v1/runtime/commands", { method: "POST", body: command, expected: 200 });

  docker("exec", postgres, "pg_dump", "-U", "openclaw", "-d", "openclaw_control_plane", "-Fc", "-f", "/tmp/runtime.dump");
  docker("exec", postgres, "createdb", "-U", "openclaw", "recovery_restore");
  docker("exec", postgres, "pg_restore", "-U", "openclaw", "-d", "recovery_restore", "/tmp/runtime.dump");
  const sourceCounts = counts("openclaw_control_plane");
  const restoredCounts = counts("recovery_restore");
  if (sourceCounts !== restoredCounts) throw new Error("Restored runtime counts do not match source.");
  runtime = await initializePostgresRuntime(restoreDatabaseUrl);
  const rebuilt = await runtime.repository.rebuildProjection({
    stream_id: "verify-stream",
    projection_type: "example.current",
    subject: target(),
    projection_version: 1,
    input_types: [{ kind: "result", type: "example.reconciliation.delta", schema_version: 1 }],
    initial_state: { changed: false },
    reduce: (_state, record) => record.payload
  });
  await runtime.close();
  if (rebuilt.state.changed !== true) throw new Error("Restored projection rebuild diverged.");

  docker("stop", api);
  startApi("postgresql://openclaw:openclaw@missing-runtime-db:5432/missing?connect_timeout=2");
  const degraded = await waitForDegradedHealth();
  if (
    degraded.api !== "unavailable" ||
    degraded.database !== "unavailable" ||
    degraded.migrations !== "missing" ||
    degraded.registry !== "invalid"
  ) {
    throw new Error(`Degraded readiness dimensions are incorrect: ${JSON.stringify(degraded)}`);
  }

  console.log(JSON.stringify({
    image,
    command: "inserted_then_replayed",
    restart: "ready",
    source_counts: sourceCounts.split("\n"),
    restored_counts: restoredCounts.split("\n"),
    projection: rebuilt.state,
    degraded_readiness: degraded
  }, null, 2));
} finally {
  for (const container of [api, postgres, issuerContainer]) {
    try { docker("rm", "-f", container); } catch {}
  }
  try { docker("network", "rm", network); } catch {}
  try { docker("volume", "rm", certVolume); } catch {}
}

function startApi(runtimeDatabaseUrl = databaseUrl) {
  docker(
    "run", "-d", "--rm", "--name", api, "--network", network,
    "-p", `127.0.0.1:${apiPort}:8787`,
    "-v", `${certVolume}:/certs:ro`, "-e", "NODE_ENV=production",
    "-e", "NODE_EXTRA_CA_CERTS=/certs/cert.pem", "-e", `DATABASE_URL=${runtimeDatabaseUrl}`,
    "-e", `RUNTIME_AUTH_CONFIG_JSON=${JSON.stringify(authConfig)}`, image
  );
}

async function waitForHealth() {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${apiPort}/health`);
    if (!response.ok) throw new Error(`health returned ${response.status}`);
  }, "runtime API");
}

async function waitForDegradedHealth() {
  let body;
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${apiPort}/health`);
    body = await response.json();
    if (response.status !== 503) throw new Error(`degraded health returned ${response.status}`);
  }, "degraded runtime API");
  return body;
}

async function waitFor(check, label) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${label} did not become ready.`, { cause: lastError });
}

async function request(path, options = {}) {
  const response = await fetch(`http://localhost:${apiPort}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  if (response.status !== options.expected) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function counts(database) {
  return docker(
    "exec", postgres, "psql", "-U", "openclaw", "-d", database, "-Atc",
    "SELECT count(*) FROM runtime_records UNION ALL SELECT count(*) FROM record_edges UNION ALL SELECT count(*) FROM idempotency_records UNION ALL SELECT count(*) FROM projection_states UNION ALL SELECT count(*) FROM projection_checkpoints UNION ALL SELECT (SELECT count(*) FROM type_registrations)+(SELECT count(*) FROM operation_registrations);"
  ).trim();
}

function target() {
  return { type: "example.environment", id: "production" };
}

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port.");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
