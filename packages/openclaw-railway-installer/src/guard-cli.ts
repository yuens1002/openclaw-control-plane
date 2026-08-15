import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

// Wraps `railway variable list`/`set` for a developer running the raw
// Railway CLI by hand. Railway's own --help text confirms `variable list
// --json`/`--kv` print raw secret values, with no confirmation prompt and
// no requirement to scope to a specific service -- the exact gap that
// caused a real secret-exposure incident (see issue #8). A rejected
// command here never spawns `railway` at all, so it never has a chance to
// print anything.
//
// Every `variable list` invocation requires confirmation, not just the
// documented --json/--kv forms: Railway's --help text only states that
// --json/--kv "include raw values" -- it says nothing about whether the
// plain (no-flag) table output masks or truncates them either way. Treating
// that silence as "safe" would be exactly the kind of unconfirmed
// assumption this guard exists to prevent, so the plain form is gated too.
export function checkGuard(args: string[]): GuardResult {
  const [resource, subcommand] = args;
  if (resource !== "variable" || (subcommand !== "list" && subcommand !== "set")) {
    return {
      ok: false,
      reason:
        "railway-guard only wraps `railway variable list` and `railway variable set`. Run other railway subcommands directly."
    };
  }

  if (!hasServiceFlag(args)) {
    return {
      ok: false,
      reason:
        "Missing -s/--service <name>. Never run variable list/set unscoped -- it silently falls back to whatever project/service the local CLI happens to be linked to."
    };
  }

  if (subcommand === "list" && !args.includes("--i-know-this-prints-secrets")) {
    return {
      ok: false,
      reason:
        '`variable list` may print raw secret values to stdout (Railway\'s own --help text confirms --json/--kv do; the plain table form is not documented as masking them either). Re-run with --i-know-this-prints-secrets once you are certain you want to see them.'
    };
  }

  return { ok: true };
}

function hasServiceFlag(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg !== "-s" && arg !== "--service") {
      return false;
    }
    const value = args[index + 1];
    // A following token that itself looks like a flag (e.g. `--service
    // --json`) is not a service name -- reject it as unscoped rather than
    // treating any non-undefined next token as a valid value.
    return value !== undefined && !value.startsWith("-");
  });
}

export function stripGuardFlag(args: string[]): string[] {
  return args.filter((arg) => arg !== "--i-know-this-prints-secrets");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = checkGuard(args);
  if (!result.ok) {
    console.error(`railway-guard: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  const railway = await resolveRailwayExecutable();
  const child = spawn(railway, stripGuardFlag(args), { stdio: "inherit", shell: false });
  child.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

// Duplicated (not imported) from ./cli.ts: that module doesn't export this
// helper, and the duplication is a handful of lines versus adding a new
// export to another entrypoint's module surface.
async function resolveRailwayExecutable(): Promise<string> {
  const npmGlobal = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@railway", "cli", "bin", "railway.exe")
    : undefined;
  if (npmGlobal) {
    try {
      await access(npmGlobal);
      return npmGlobal;
    } catch {
      // Fall back to PATH.
    }
  }
  return "railway";
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  return Boolean(invokedPath && fileURLToPath(import.meta.url) === invokedPath);
}
