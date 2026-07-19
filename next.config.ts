import type { NextConfig } from "next";

const githubPagesBasePath = "/PhoneRoll";
const isGithubPagesBuild = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  ...(isGithubPagesBuild
    ? {
        output: "export" as const,
        basePath: githubPagesBasePath,
        assetPrefix: `${githubPagesBasePath}/`,
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
