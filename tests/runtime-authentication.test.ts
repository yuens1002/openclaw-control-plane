import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey
} from "jose";
import { createServer } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  OidcAuthenticator,
  checkIdentityReadiness,
  exampleRuntimeAuthConfiguration
} from "@openclaw-control-plane/runtime-auth";

type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: GeneratedPrivateKey;
let publicJwk: JWK;
let rotatedPrivateKey: GeneratedPrivateKey;
let rotatedPublicJwk: JWK;

beforeAll(async () => {
  const original = await generateKeyPair("RS256");
  privateKey = original.privateKey;
  publicJwk = { ...(await exportJWK(original.publicKey)), kid: "key-1", alg: "RS256" };
  const rotated = await generateKeyPair("RS256");
  rotatedPrivateKey = rotated.privateKey;
  rotatedPublicJwk = { ...(await exportJWK(rotated.publicKey)), kid: "key-2", alg: "RS256" };
});

describe("OIDC authentication", () => {
  it("rejects unsafe remote JWKS cache timing overrides", () => {
    expect(() =>
      new OidcAuthenticator(exampleRuntimeAuthConfiguration, {
        remoteJwks: { cooldownDuration: -1, cacheMaxAge: Infinity }
      })
    ).toThrow(/Remote JWKS/i);
  });
  it("verifies a token and resolves stable identity independently of mutable claims", async () => {
    const authenticator = createAuthenticator(() => [publicJwk]);
    const first = await authenticator.authenticateBearer(
      `Bearer ${await token(privateKey, "key-1", { name: "Old name", email: "old@example.test" })}`
    );
    const second = await authenticator.authenticateBearer(
      `Bearer ${await token(privateKey, "key-1", { name: "New name", email: "new@example.test" })}`
    );

    expect(first.principal.principal_id).toBe("principal://example/service");
    expect(second.principal.principal_id).toBe(first.principal.principal_id);
  });

  it.each([
    ["expired", { expirationTime: Math.floor(Date.now() / 1000) - 60 }],
    ["not yet valid", { notBefore: Math.floor(Date.now() / 1000) + 600 }],
    ["wrong audience", { audience: "other" }],
    ["wrong issuer", { issuer: "https://other.example" }]
  ])("rejects a %s token", async (_case, override) => {
    const authenticator = createAuthenticator(() => [publicJwk]);
    await expect(
      authenticator.authenticateBearer(`Bearer ${await token(privateKey, "key-1", {}, override)}`)
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects unknown keys and unsupported algorithms", async () => {
    const authenticator = createAuthenticator(() => [publicJwk]);
    await expect(
      authenticator.authenticateBearer(`Bearer ${await token(rotatedPrivateKey, "key-2")}`)
    ).rejects.toBeInstanceOf(AuthenticationError);

    const hsToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://issuer.example")
      .setSubject("example-service")
      .setAudience("control-plane")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a sufficiently long unsupported test secret"));
    await expect(authenticator.authenticateBearer(`Bearer ${hsToken}`)).rejects.toMatchObject({
      code: "unsupported_algorithm"
    });
  });

  it("rejects malformed tokens and unmapped stable identities", async () => {
    const authenticator = createAuthenticator(() => [publicJwk]);
    await expect(authenticator.authenticateBearer("Bearer not-a-jwt")).rejects.toBeInstanceOf(
      AuthenticationError
    );
    await expect(
      authenticator.authenticateBearer(
        `Bearer ${await token(privateKey, "key-1", {}, { subject: "other-service" })}`
      )
    ).rejects.toMatchObject({ code: "unknown_principal" });
  });

  it("rejects tokens without required expiry and issued-at claims", async () => {
    const authenticator = createAuthenticator(() => [publicJwk]);
    const missingExpiry = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer("https://issuer.example")
      .setSubject("example-service")
      .setAudience("control-plane")
      .setIssuedAt()
      .sign(privateKey);

    await expect(
      authenticator.authenticateBearer(`Bearer ${missingExpiry}`)
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("accepts a new key and rejects the retired key after a deterministic refresh", async () => {
    let keys = [publicJwk];
    const authenticator = createAuthenticator(() => keys);

    await expect(
      authenticator.authenticateBearer(`Bearer ${await token(privateKey, "key-1")}`)
    ).resolves.toMatchObject({ subject: "example-service" });
    keys = [rotatedPublicJwk];
    await expect(
      authenticator.authenticateBearer(`Bearer ${await token(rotatedPrivateKey, "key-2")}`)
    ).resolves.toMatchObject({ subject: "example-service" });
    await expect(
      authenticator.authenticateBearer(`Bearer ${await token(privateKey, "key-1")}`)
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("bounds remote JWKS refreshes and replaces retired keys", async () => {
    let keys = [publicJwk];
    let fetches = 0;
    const server = createServer((_request, response) => {
      fetches += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("JWKS fixture did not bind.");
    const issuer = `http://127.0.0.1:${address.port}`;
    const config = {
      ...exampleRuntimeAuthConfiguration,
      issuers: [
        {
          ...exampleRuntimeAuthConfiguration.issuers[0]!,
          issuer,
          jwks_uri: `${issuer}/jwks`
        }
      ],
      principals: exampleRuntimeAuthConfiguration.principals.map((principal) => ({
        ...principal,
        issuer
      }))
    };
    const authenticator = new OidcAuthenticator(config, {
      remoteJwks: { cooldownDuration: 20, cacheMaxAge: 60_000, timeoutDuration: 1_000 }
    });

    try {
      await expect(
        authenticator.authenticateBearer(
          `Bearer ${await token(privateKey, "key-1", {}, { issuer })}`
        )
      ).resolves.toMatchObject({ subject: "example-service" });
      keys = [rotatedPublicJwk];
      await expect(
        authenticator.authenticateBearer(
          `Bearer ${await token(rotatedPrivateKey, "key-2", {}, { issuer })}`
        )
      ).rejects.toBeInstanceOf(AuthenticationError);
      const fetchesDuringCooldown = fetches;
      await expect(
        authenticator.authenticateBearer(
          `Bearer ${await token(rotatedPrivateKey, "key-2", {}, { issuer })}`
        )
      ).rejects.toBeInstanceOf(AuthenticationError);
      expect(fetches).toBe(fetchesDuringCooldown);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(
        authenticator.authenticateBearer(
          `Bearer ${await token(rotatedPrivateKey, "key-2", {}, { issuer })}`
        )
      ).resolves.toMatchObject({ subject: "example-service" });
      await expect(
        authenticator.authenticateBearer(
          `Bearer ${await token(privateKey, "key-1", {}, { issuer })}`
        )
      ).rejects.toBeInstanceOf(AuthenticationError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports required JWKS readiness independently", async () => {
    const ready = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
    );
    const unavailable = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      new Response("unavailable", { status: 503 })
    );

    expect(ready).toEqual({ identity: "ready", jwks: "ready" });
    expect(unavailable).toEqual({ identity: "ready", jwks: "unavailable" });
  });

  it("reports JWKS with duplicate or incompatible keys as unavailable", async () => {
    const duplicate = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      Response.json({ keys: [publicJwk, publicJwk] })
    );
    const incompatible = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      Response.json({ keys: [{ kid: "key-1", kty: "EC", alg: "ES256" }] })
    );
    const metadataOnly = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      Response.json({ keys: [{ kid: "key-1", kty: "RSA", alg: "RS256" }] })
    );
    const wrongUse = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      Response.json({ keys: [{ ...publicJwk, use: "other" }] })
    );
    const signOnly = await checkIdentityReadiness(exampleRuntimeAuthConfiguration, async () =>
      Response.json({ keys: [{ ...publicJwk, key_ops: ["sign"] }] })
    );

    expect(duplicate.jwks).toBe("unavailable");
    expect(incompatible.jwks).toBe("unavailable");
    expect(metadataOnly.jwks).toBe("unavailable");
    expect(wrongUse.jwks).toBe("unavailable");
    expect(signOnly.jwks).toBe("unavailable");
  });
});

function createAuthenticator(keys: () => JWK[]) {
  const resolver: JWTVerifyGetKey = async (header, token) =>
    createLocalJWKSet({ keys: keys() })(header, token);
  return new OidcAuthenticator(exampleRuntimeAuthConfiguration, {
    createJwks: () => resolver
  });
}

async function token(
  key: GeneratedPrivateKey,
  kid: string,
  claims: Record<string, unknown> = {},
  override: {
    issuer?: string;
    audience?: string;
    expirationTime?: number;
    notBefore?: number;
    subject?: string;
  } = {}
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(override.issuer ?? "https://issuer.example")
    .setSubject(override.subject ?? "example-service")
    .setAudience(override.audience ?? "control-plane")
    .setIssuedAt()
    .setNotBefore(override.notBefore ?? 0)
    .setExpirationTime(override.expirationTime ?? "5m")
    .sign(key);
}
