import { serve } from "@hono/node-server";
import { createControlPlaneApp } from "./index.js";

const port = Number(process.env.PORT ?? 8787);

serve({
  fetch: createControlPlaneApp().fetch,
  port
});

console.log(`openclaw-control-plane API listening on :${port}`);
