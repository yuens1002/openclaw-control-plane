import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload
} from "jose";

import type {
  IssuerConfiguration,
  PrincipalConfiguration,
  RuntimeAuthConfiguration
} from "./config.js";

export interface AuthenticatedPrincipal {
  issuer: string;
  subject: string;
  principal: PrincipalConfiguration;
  claims: JWTPayload;
}

export interface OidcAuthenticatorOptions {
  createJwks?: (issuer: IssuerConfiguration) => JWTVerifyGetKey;
}

export class OidcAuthenticator {
  private readonly issuers = new Map<string, IssuerConfiguration>();
  private readonly principals = new Map<string, PrincipalConfiguration>();
  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  constructor(config: RuntimeAuthConfiguration, options: OidcAuthenticatorOptions = {}) {
    for (const issuer of config.issuers) {
      this.issuers.set(issuer.issuer, issuer);
      this.jwks.set(
        issuer.issuer,
        options.createJwks?.(issuer) ??
          createRemoteJWKSet(new URL(issuer.jwks_uri), {
            cooldownDuration: 30_000,
            cacheMaxAge: 600_000,
            timeoutDuration: 5_000
          })
      );
    }
    for (const principal of config.principals) {
      this.principals.set(identityKey(principal.issuer, principal.subject), principal);
    }
  }

  async authenticateBearer(authorizationHeader: string | undefined): Promise<AuthenticatedPrincipal> {
    const token = parseBearerToken(authorizationHeader);
    let unverifiedClaims: JWTPayload;
    let unverifiedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      unverifiedClaims = decodeJwt(token);
      unverifiedHeader = decodeProtectedHeader(token);
    } catch {
      throw new AuthenticationError("invalid_token");
    }
    const issuerName = unverifiedClaims.iss;
    if (!issuerName) throw new AuthenticationError("unknown_issuer");
    const issuer = this.issuers.get(issuerName);
    if (!issuer) throw new AuthenticationError("unknown_issuer");
    if (
      !unverifiedHeader.alg ||
      !issuer.allowed_algorithms.some((algorithm) => algorithm === unverifiedHeader.alg)
    ) {
      throw new AuthenticationError("unsupported_algorithm");
    }
    const key = this.jwks.get(issuerName);
    if (!key) throw new AuthenticationError("jwks_unavailable");

    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(token, key, {
        issuer: issuer.issuer,
        audience: issuer.audiences,
        algorithms: issuer.allowed_algorithms,
        clockTolerance: issuer.clock_skew_seconds,
        requiredClaims: ["exp", "iat", "sub"]
      });
      claims = verified.payload;
    } catch {
      throw new AuthenticationError("invalid_token");
    }
    if (!claims.sub) throw new AuthenticationError("unknown_principal");
    const principal = this.principals.get(identityKey(issuer.issuer, claims.sub));
    if (!principal) throw new AuthenticationError("unknown_principal");
    return { issuer: issuer.issuer, subject: claims.sub, principal, claims };
  }
}

export class AuthenticationError extends Error {
  constructor(readonly code: string) {
    super("Authentication failed.");
    this.name = "AuthenticationError";
  }
}

function parseBearerToken(header: string | undefined): string {
  if (!header) throw new AuthenticationError("missing_bearer_token");
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match?.[1]) throw new AuthenticationError("invalid_authorization_header");
  return match[1];
}

function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}
