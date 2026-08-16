// Relocated to @openclaw-control-plane/openclaw-railway-installer, which
// both this package and the new client-provisioning code depend on. This
// package's own `./railway-variables` export path stays in place so
// existing imports (e.g. apply-profile.ts's `./railway-variables.js`)
// don't need to change.
export * from "@openclaw-control-plane/openclaw-railway-installer/railway-variables";
