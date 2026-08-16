import { describe, expect, it } from "vitest";

import { basicAuthHeader } from "@openclaw-control-plane/openclaw-railway-installer/setup-auth";

describe("basicAuthHeader", () => {
  it("base64-encodes username:password as a Basic auth header", () => {
    const header = basicAuthHeader({ username: "openclaw-admin", password: "setup-secret" });
    expect(header).toBe(`Basic ${Buffer.from("openclaw-admin:setup-secret").toString("base64")}`);
    expect(header.startsWith("Basic ")).toBe(true);
  });
});
