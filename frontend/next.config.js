const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    disableDevLogs: true,
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/cvrp/:path*",
        destination: "http://163.52.135.197:8000/:path*",
      },
      {
        source: "/api/osrm/:path*",
        destination: "http://ficom.mayora.co.id:8081/osrm-api/:path*",
      },
    ];
  },
};

module.exports = withPWA(nextConfig);
