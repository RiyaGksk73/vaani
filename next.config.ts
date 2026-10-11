import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Script rows are fetched in large keyset-paginated pages; keep the
    // server action payload ceiling low so nothing large is round-tripped.
    serverActions: { bodySizeLimit: "1mb" },
  },
};

export default nextConfig;
