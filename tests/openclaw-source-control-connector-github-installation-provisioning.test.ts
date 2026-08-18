import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildAppJwt,
  GitHubProvisioningError,
  mintInstallationToken
} from "@openclaw-control-plane/openclaw-source-control-connector/github-installation-provisioning";

// Every test in this file stubs `fetch`. Minting is real, live-usable-for-an-
// hour, and cannot be un-minted against the actual GitHub API — no test here
// may reach `https://api.github.com`.

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("buildAppJwt", () => {
  it("produces a 3-segment RS256 JWT with iat/exp/iss and a verifiable signature", () => {
    const fixedNow = (): Date => new Date("2026-01-01T00:10:00.000Z");
    const jwt = buildAppJwt("123456", privateKey, fixedNow);

    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);

    const header = decodeSegment(segments[0]!) as Record<string, unknown>;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = decodeSegment(segments[1]!) as { iat: number; exp: number; iss: string };
    const nowSeconds = Math.floor(fixedNow().getTime() / 1000);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(nowSeconds - 60);
    expect(payload.exp).toBe(payload.iat + 600);

    const signingInput = `${segments[0]}.${segments[1]}`;
    const signature = Buffer.from(segments[2]!, "base64url");
    expect(cryptoVerify("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature)).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  it("POSTs to /app/installations/{id}/access_tokens with a Bearer JWT, Accept, and API-version headers", async () => {
    const requests: Array<{ url: string; method: string | undefined; headers: Record<string, string> }> = [];

    const minted = await mintInstallationToken("999", {
      appId: "123456",
      privateKeyPem: privateKey,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          headers: init?.headers as Record<string, string>
        });
        return new Response(
          JSON.stringify({
            token: "ghs_DO-NOT-LOG-test-token",
            expires_at: "2026-01-01T01:00:00Z",
            permissions: { contents: "read", metadata: "read" }
          }),
          { status: 201 }
        );
      }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/app/installations/999/access_tokens");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.authorization).toMatch(/^Bearer /);
    expect(requests[0]?.headers.accept).toBe("application/vnd.github+json");
    expect(requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28");

    // The JWT actually sent carries the same appId buildAppJwt would encode.
    const sentJwt = requests[0]!.headers.authorization!.replace("Bearer ", "");
    const sentSegments = sentJwt.split(".");
    expect(decodeSegment(sentSegments[1]!)).toMatchObject({ iss: "123456" });

    expect(minted).toEqual({
      token: "ghs_DO-NOT-LOG-test-token",
      expiresAt: "2026-01-01T01:00:00Z",
      permissions: { contents: "read", metadata: "read" }
    });
  });

  it("throws GitHubProvisioningError with the status and never leaks the response body", async () => {
    const error = await mintInstallationToken("999", {
      appId: "123456",
      privateKeyPem: privateKey,
      fetchImpl: async () => new Response(JSON.stringify({ message: "DO-NOT-LOG-leak" }), { status: 403 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubProvisioningError);
    expect((error as GitHubProvisioningError).status).toBe(403);
    expect((error as Error).message).not.toContain("DO-NOT-LOG-leak");
  });

  it("throws naming the missing field when 'token' is absent", async () => {
    const error = await mintInstallationToken("999", {
      appId: "123456",
      privateKeyPem: privateKey,
      fetchImpl: async () =>
        new Response(JSON.stringify({ expires_at: "2026-01-01T01:00:00Z", permissions: {} }), { status: 201 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("token");
  });

  it("throws naming the missing field when 'expires_at' is absent", async () => {
    const error = await mintInstallationToken("999", {
      appId: "123456",
      privateKeyPem: privateKey,
      fetchImpl: async () => new Response(JSON.stringify({ token: "ghs_x", permissions: {} }), { status: 201 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("expires_at");
  });

  it("throws naming the missing field when 'permissions' is absent", async () => {
    const error = await mintInstallationToken("999", {
      appId: "123456",
      privateKeyPem: privateKey,
      fetchImpl: async () =>
        new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-01-01T01:00:00Z" }), { status: 201 })
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("permissions");
  });
});
