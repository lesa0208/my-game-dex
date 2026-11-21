import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Development only: the route indicator sat over the sidebar's tagline.
  devIndicators: { position: "bottom-right" },
  experimental: {
    serverActions: {
      // M11a-3: room for a 2 MB avatar and the multipart framing around it
      // (ACTION_BODY_LIMIT_BYTES in src/features/avatars/form.ts; profile.test.mjs checks
      // they agree). Applies to every Server Action, up from the default 1 MB. Next.js
      // refuses a bigger body before any action runs.
      bodySizeLimit: 2 * 1024 * 1024 + 64 * 1024,
    },
  },
  partialPrefetching: true,
  // M8d (D10): the review pages moved under /admin/catalog. Permanent (308), applied
  // before the proxy, with the query passed through. Each page still checks access.
  async redirects() {
    return [
      { source: "/review", destination: "/admin/catalog", permanent: true },
      { source: "/review/:path*", destination: "/admin/catalog/:path*", permanent: true },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
