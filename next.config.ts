import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the dev-only Next.js badge clear of the sidebar.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // Script rows are fetched in large keyset-paginated pages; keep the
    // server action payload ceiling low so nothing large is round-tripped.
    serverActions: { bodySizeLimit: "1mb" },
  },
};

export default nextConfig;
