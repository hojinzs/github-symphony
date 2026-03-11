import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["dockerode"],
  transpilePackages: [
    "@gh-symphony/core",
    "@gh-symphony/tracker-github"
  ]
};

export default nextConfig;
