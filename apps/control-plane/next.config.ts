import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["dockerode"],
  transpilePackages: ["@github-symphony/shared"]
};

export default nextConfig;
