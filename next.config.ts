import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'xmachine.local',
    'headroom-sponsor-rethink.ngrok-free.dev',
  ],
  experimental: {
    // Without this, Next.js ignores nginx's forwarded Host header and falls back to a
    // hardcoded 'localhost' when building an absolute URL from a relative one (e.g.
    // `new URL('/path', req.url)`) — invisible for routes that never do that, but broke
    // the Fanvue OAuth callback's final redirect, which always landed on
    // https://localhost:3000/... instead of the real domain no matter what was
    // configured on the Fanvue app or in our own env vars. Safe to trust here because
    // nginx (the only thing that can reach this process) sets Host from its own
    // server_name, not from whatever a client sends.
    // @ts-expect-error — real, runtime-read flag (see server/config-shared.js), just not
    // in this Next version's published NextConfig type yet.
    trustHostHeader: true,
  },
  turbopack: {
    root: process.cwd(),
  },
  serverExternalPackages: [
    'playwright-extra',
    'playwright-core',
    'puppeteer-extra-plugin-stealth',
    'instagram-private-api',
    'ssh2',
    'cpu-features',
  ],
};

export default nextConfig;