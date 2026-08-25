import { describe, expect, it } from "vitest";

import { loadMcpAppConfig } from "@openclaw-control-plane/mcp";

describe("MCP application configuration", () => {
  it("loads stdio without hosted credentials and keeps concerns separate", () => {
    const config = loadMcpAppConfig(baseEnvironment());

    expect(config).toMatchObject({
      mode: "stdio",
      runtime: { baseUrl: "https://runtime.example", allowInsecureTransport: false },
      token: {
        tokenEndpoint: "https://issuer.example/token",
        clientId: "client-id",
        authMethod: "client_secret_basic"
      }
    });
    expect(config.hosted).not.toHaveProperty("bearerToken");
  });

  it("requires a distinct hosted inbound bearer credential", () => {
    expect(() =>
      loadMcpAppConfig({ ...baseEnvironment(), MCP_TRANSPORT: "streamable-http" })
    ).toThrow(/Hosted MCP requires an inbound bearer token/);

    expect(
      loadMcpAppConfig({
        ...baseEnvironment(),
        MCP_TRANSPORT: "streamable-http",
        MCP_INBOUND_BEARER_TOKEN: "separate-bridge-secret",
        MCP_ALLOWED_ORIGINS: "https://one.example,https://two.example"
      }).hosted
    ).toMatchObject({
      bearerToken: "separate-bridge-secret",
      allowedOrigins: ["https://one.example", "https://two.example"]
    });
    expect(() =>
      loadMcpAppConfig({
        ...baseEnvironment(),
        MCP_TRANSPORT: "streamable-http",
        MCP_INBOUND_BEARER_TOKEN: "separate-bridge-secret",
        MCP_ALLOWED_ORIGINS: "https://one.example/path"
      })
    ).toThrow(/without credentials or paths/);
  });

  it("fails unsafe production transport and permits explicit local development", () => {
    expect(() =>
      loadMcpAppConfig({
        ...baseEnvironment(),
        RUNTIME_API_URL: "http://runtime.example"
      })
    ).toThrow(/requires HTTPS/);

    expect(() =>
      loadMcpAppConfig({
        ...baseEnvironment(),
        MCP_ALLOW_INSECURE_TRANSPORT: "true"
      })
    ).toThrow(/unavailable in production/);

    expect(
      loadMcpAppConfig({
        ...baseEnvironment(),
        NODE_ENV: "development",
        RUNTIME_API_URL: "http://127.0.0.1:3000",
        OIDC_TOKEN_ENDPOINT: "http://127.0.0.1:4000/token",
        MCP_ALLOW_INSECURE_TRANSPORT: "true"
      }).runtime.allowInsecureTransport
    ).toBe(true);

    expect(() =>
      loadMcpAppConfig({
        ...baseEnvironment(),
        NODE_ENV: "development",
        RUNTIME_API_URL: "http://runtime.remote.example",
        OIDC_TOKEN_ENDPOINT: "http://issuer.remote.example/token",
        MCP_ALLOW_INSECURE_TRANSPORT: "true"
      })
    ).toThrow(/requires HTTPS/);
  });

  it("does not include literal secrets in configuration failures", () => {
    const secret = "sentinel-client-secret";
    try {
      loadMcpAppConfig({
        ...baseEnvironment(),
        OIDC_CLIENT_SECRET: secret,
        OIDC_TOKEN_ENDPOINT: "not-a-url"
      });
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    MCP_TRANSPORT: "stdio",
    RUNTIME_API_URL: "https://runtime.example",
    OIDC_TOKEN_ENDPOINT: "https://issuer.example/token",
    OIDC_CLIENT_ID: "client-id",
    OIDC_CLIENT_SECRET: "client-secret"
  };
}
