import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["dockerode"],
  transpilePackages: [
    "@github-symphony/core",
    "@github-symphony/shared",
    "@github-symphony/tracker-github"
  ]
};

export default nextConfig;
