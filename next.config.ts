import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/adapter-pg"],
  images: {
    formats: ["image/avif", "image/webp"],
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        // "0" on purpose: the legacy XSS auditor is removed from modern browsers and
        // "1; mode=block" could itself be abused; the per-request CSP covers it.
        { key: "X-XSS-Protection", value: "0" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
        // CSP is set per-request in src/proxy.ts (nonce on signed-in pages)
      ],
    },
  ],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // The proxy buffers request bodies and truncates at 10 MB by default, which
    // turned a 10–25 MB statement PDF into "Expected a file upload". The upload
    // routes cap at 25 MB themselves.
    proxyClientMaxBodySize: "26mb",
  },
  env: {
    NEXT_PUBLIC_APP_NAME: "SpendTrack",
    NEXT_PUBLIC_APP_VERSION: "0.1.0",
  },
};

export default nextConfig;
