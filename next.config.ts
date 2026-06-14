import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'xmachine.local',
    'headroom-sponsor-rethink.ngrok-free.dev',
  ],
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