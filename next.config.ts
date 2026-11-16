import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
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
