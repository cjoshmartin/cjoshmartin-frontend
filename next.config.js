/** @type {import('next').NextConfig} */
const nextConfig = {
    images: {
      domains: [
        "images.unsplash.com"
      ],
        remotePatterns: [
          {
            protocol: "http",
            hostname: "45.55.48.61",
            port: "",
            pathname: "/media/**",
          },
        ],
        dangerouslyAllowSVG: true,
      },
}

module.exports = nextConfig
