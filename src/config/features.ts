/**
 * Seed data is on during development and off in production builds, where the
 * app shows its real empty states. Set ENABLE_SEED_DATA=true to include it in a
 * production build, for example on a preview deployment.
 */
export const isSeedDataEnabled =
  process.env.NODE_ENV !== "production" ||
  process.env.ENABLE_SEED_DATA === "true";
