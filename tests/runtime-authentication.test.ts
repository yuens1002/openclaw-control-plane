import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey
} from "jose";
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
  } = {}
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(override.issuer ?? "https://issuer.example")
    .setSubject("example-service")
    .setAudience(override.audience ?? "control-plane")
    .setIssuedAt()
    .setExpirationTime(override.expirationTime ?? "5m")
    .sign(key);
}
