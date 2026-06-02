import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['xmachine.local'],
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: [
    'playwright-extra',
    'playwright-core',
    'puppeteer-extra-plugin-stealth',
    'instagram-private-api',
  ],
};

export default nextConfig;
