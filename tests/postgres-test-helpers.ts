import { describe } from "vitest";

const configuredConnectionString = process.env.TEST_DATABASE_URL;
const hasConfiguredDatabase = Boolean(
  configuredConnectionString &&
  !["undefined", "null"].includes(configuredConnectionString.trim().toLowerCase())
);

export const postgresTestConnectionString =
  hasConfiguredDatabase
    ? configuredConnectionString!
    : "postgresql://unused:unused@localhost:5432/unused";

export function describePostgres(name: string, factory: () => void): void {
  const collect = hasConfiguredDatabase ? describe : describe.skip;
  collect(name, factory);
}
