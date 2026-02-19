import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@quri/squiggle-components",
    "@quri/squiggle-lang",
    "@quri/ui",
  ],
};

export default nextConfig;
