import {
  checkTemplateUpdate,
  formatTemplateUpdateStatus,
  readTemplateLock
} from "./template-lock.js";

async function main(): Promise<void> {
  const lockPath = process.argv[2] ?? "deploy/openclaw-railway/template-lock.json";
  const lock = await readTemplateLock(lockPath);
  const result = await checkTemplateUpdate(lock);

  console.log(formatTemplateUpdateStatus(result));

  if (result.status === "update_available") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
