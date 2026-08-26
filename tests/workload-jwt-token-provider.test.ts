import { generateKeyPairSync } from "node:crypto";

import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK } from "jose";
import { describe, expect, it } from "vitest";

import { createWorkloadJwtTokenProvider } from "@openclaw-control-plane/decision-runtime-mcp/token-provider";
import {
  OidcAuthenticator,
  exampleRuntimeAuthConfiguration
} from "@openclaw-control-plane/runtime-auth";

describe("workload JWT token provider", () => {
  it.each([
    ["RS256", rsaKey()],
    ["ES256", ecKey()],
    ["EdDSA", edKey()]
  ] as const)("signs and verifies %s tokens with exact workload identity", async (algorithm, pair) => {
    const provider = createProvider(pair.privatePem, algorithm, {
      now: () => 1_800_000_000_000,
      randomId: () => "invocation-1"
    });
    const token = await provider.getToken();
    const claims = decodeJwt(token);
    const header = decodeProtectedHeader(token);

    expect(header).toMatchObject({ alg: algorithm, kid: "workload-key-1", typ: "JWT" });
    expect(claims).toMatchObject({
      iss: "https://issuer.example",
      sub: "example-workload",
      aud: "control-plane",
      iat: 1_800_000_000,
      exp: 1_800_000_120,
      jti: "invocation-1"
    });

    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "workload-key-1",
      alg: algorithm
    };
    const config = {
      ...exampleRuntimeAuthConfiguration,
      issuers: [
        {
          ...exampleRuntimeAuthConfiguration.issuers[0]!,
          audiences: ["control-plane"],
          allowed_algorithms: [algorithm]
        }
      ],
      principals: [
        {
          ...exampleRuntimeAuthConfiguration.principals[0]!,
          subject: "example-workload"
        }
      ]
    };
    const authenticator = new OidcAuthenticator(config, {
      createJwks: () => createLocalJWKSet({ keys: [publicJwk] })
    });

    await expect(authenticator.authenticateBearer(`Bearer ${token}`)).resolves.toMatchObject({
      subject: "example-workload",
      principal: { principal_id: "principal://example/service" }
    });
  });

  it("bounds cache lifetime, coalesces signing, and supports invalidation", async () => {
    const pair = rsaKey();
    let timestamp = 1_800_000_000_000;
    let randomCalls = 0;
    const provider = createProvider(pair.privatePem, "RS256", {
      now: () => timestamp,
      randomId: () => `token-${++randomCalls}`
    });

    const [one, two] = await Promise.all([provider.getToken(), provider.getToken()]);
    expect(one).toBe(two);
    expect(randomCalls).toBe(1);
    timestamp += 89_000;
    await expect(provider.getToken()).resolves.toBe(one);
    timestamp += 1_000;
    const refreshed = await provider.getToken();
    expect(refreshed).not.toBe(one);
    expect(randomCalls).toBe(2);
    provider.invalidate("another-token");
    await expect(provider.getToken()).resolves.toBe(refreshed);
    provider.invalidate(refreshed);
    await provider.getToken();
    expect(randomCalls).toBe(3);
  });

  it.each([
    ["wrong issuer", { issuer: "https://other.example" }, {}, "unknown_issuer"],
    ["wrong audience", { audience: "other-runtime" }, {}, "invalid_token"],
    ["unknown subject", { subject: "unknown-workload" }, {}, "unknown_principal"],
    ["unknown key ID", { keyId: "unknown-key" }, {}, "invalid_token"],
    ["unsupported verifier algorithm", {}, { allowedAlgorithms: ["ES256"] }, "unsupported_algorithm"],
    ["expired token", {}, { now: () => 1_000_000_000_000 }, "invalid_token"]
  ] as const)("fails closed for %s", async (_name, tokenOverrides, authOverrides, code) => {
    const pair = rsaKey();
    const provider = createProvider(
      pair.privatePem,
      "RS256",
      "now" in authOverrides ? { now: authOverrides.now } : {},
      tokenOverrides
    );
    const token = await provider.getToken();
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "workload-key-1",
      alg: "RS256"
    };
    const config = {
      ...exampleRuntimeAuthConfiguration,
      issuers: [
        {
          ...exampleRuntimeAuthConfiguration.issuers[0]!,
          audiences: ["control-plane"],
          allowed_algorithms:
            "allowedAlgorithms" in authOverrides
              ? [...authOverrides.allowedAlgorithms]
              : ["RS256" as const]
        }
      ],
      principals: [
        {
          ...exampleRuntimeAuthConfiguration.principals[0]!,
          subject: "example-workload"
        }
      ]
    };
    const authenticator = new OidcAuthenticator(config, {
      createJwks: () => createLocalJWKSet({ keys: [publicJwk] })
    });

    await expect(authenticator.authenticateBearer(`Bearer ${token}`)).rejects.toMatchObject({
      code
    });
  });

  it("fails unsafe, malformed, mismatched, and invalid lifetime configurations safely", () => {
    const rsa = rsaKey();
    const ec = ecKey();
    expect(() =>
      createProvider(rsa.privatePem, "RS256", {}, { issuer: "http://issuer.example" })
    ).toThrow(/requires HTTPS/);
    expect(() =>
      createProvider(ec.privatePem, "RS256")
    ).toThrow(/does not match/);
    const weakRsa = keyFixture(generateKeyPairSync("rsa", { modulusLength: 1024 }));
    expect(() => createProvider(weakRsa.privatePem, "RS256")).toThrow(/does not match/);
    const sentinel = "sentinel-private-key";
    try {
      createProvider(`-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----`, "RS256");
      throw new Error("expected key validation failure");
    } catch (error) {
      expect(String(error)).toContain("Invalid workload JWT private key");
      expect(String(error)).not.toContain(sentinel);
    }
    expect(() =>
      createProvider(rsa.privatePem, "RS256", {}, { lifetimeSeconds: 29 })
    ).toThrow();
    expect(() =>
      createProvider(rsa.privatePem, "RS256", {}, { refreshSkewSeconds: 120 })
    ).toThrow(/shorter than its lifetime/);
  });
});

function createProvider(
  privateKeyPem: string,
  algorithm: "RS256" | "ES256" | "EdDSA",
  options: Parameters<typeof createWorkloadJwtTokenProvider>[1] = {},
  overrides: Record<string, unknown> = {}
) {
  return createWorkloadJwtTokenProvider(
    {
      issuer: "https://issuer.example",
      subject: "example-workload",
      audience: "control-plane",
      keyId: "workload-key-1",
      algorithm,
      privateKeyPem,
      lifetimeSeconds: 120,
      refreshSkewSeconds: 30,
      ...overrides
    },
    options
  );
}

function rsaKey() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return keyFixture(pair);
}

function ecKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return keyFixture(pair);
}

function edKey() {
  const pair = generateKeyPairSync("ed25519");
  return keyFixture(pair);
}

function keyFixture(pair: ReturnType<typeof generateKeyPairSync>) {
  return {
    privatePem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey
  };
}
