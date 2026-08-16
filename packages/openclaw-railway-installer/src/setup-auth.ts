export interface SetupAuth {
  username: string;
  password: string;
}

export function basicAuthHeader(auth: SetupAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}
