import { describe, expect, it } from "vitest";

import { checkGuard, stripGuardFlag } from "@openclaw-control-plane/openclaw-railway-installer/guard-cli";

describe("railway variable guard", () => {
  it("rejects commands other than variable list/set", () => {
    expect(checkGuard(["domain", "list", "--service", "api"])).toMatchObject({ ok: false });
    expect(checkGuard(["variable", "delete", "KEY", "--service", "api"])).toMatchObject({ ok: false });
  });

  it("rejects variable list/set without --service", () => {
    expect(checkGuard(["variable", "list", "--json"])).toMatchObject({ ok: false });
    expect(checkGuard(["variable", "set", "KEY=value"])).toMatchObject({ ok: false });
  });

  it("accepts a service flag given as -s", () => {
    expect(checkGuard(["variable", "set", "KEY=value", "-s", "api"])).toMatchObject({ ok: true });
  });

  it("rejects scoped variable list --json/--kv without the confirmation flag", () => {
    expect(checkGuard(["variable", "list", "--service", "api", "--json"])).toMatchObject({ ok: false });
    expect(checkGuard(["variable", "list", "--service", "api", "--kv"])).toMatchObject({ ok: false });
    expect(checkGuard(["variable", "list", "--service", "api", "-k"])).toMatchObject({ ok: false });
  });

  it("rejects scoped variable list with no format flags without the confirmation flag", () => {
    // Railway's --help documents --json/--kv as printing raw values but says
    // nothing about whether the plain table masks them -- treat unconfirmed
    // silence as unsafe, not as an implicit "no raw values" guarantee.
    expect(checkGuard(["variable", "list", "--service", "api"])).toMatchObject({ ok: false });
  });

  it("accepts scoped variable list --json once confirmed", () => {
    expect(
      checkGuard(["variable", "list", "--service", "api", "--json", "--i-know-this-prints-secrets"])
    ).toEqual({ ok: true });
  });

  it("accepts scoped variable list with no format flags once confirmed", () => {
    expect(
      checkGuard(["variable", "list", "--service", "api", "--i-know-this-prints-secrets"])
    ).toEqual({ ok: true });
  });

  it("accepts scoped variable set unconfirmed, since set alone does not print raw values", () => {
    expect(checkGuard(["variable", "set", "KEY=value", "--service", "api"])).toEqual({ ok: true });
  });

  it("strips the guard-only confirmation flag before forwarding to the real CLI", () => {
    expect(
      stripGuardFlag(["variable", "list", "--service", "api", "--json", "--i-know-this-prints-secrets"])
    ).toEqual(["variable", "list", "--service", "api", "--json"]);
  });
});
