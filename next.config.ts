import type { NextConfig } from "next";

// M15: the pilot preview (scripts/pilot-preview.mjs) builds into its own folder, so a build made
// with the pilot's data never replaces .next (which the app checks and the B1 preview serve), and
// the reverse. M16: the demo preview (scripts/demo-preview.mjs) builds into .next-demo the same way.
// Nothing else may be chosen.
const distDir = process.env.MGD_NEXT_DIST_DIR;
if (distDir !== undefined && distDir !== ".next-pilot" && distDir !== ".next-demo") throw new Error(`MGD_NEXT_DIST_DIR may only be ".next-pilot" or ".next-demo", not "${distDir}".`);

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
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
  // M18a: IGDB's images, by their id (igdbImageUrl), through the app's image optimizer only:
  // the server fetches and caches them, so a browser never contacts IGDB. Nothing else remote.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.igdb.com", port: "", pathname: "/igdb/image/upload/**", search: "" }],
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
