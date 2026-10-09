/** PM2 — API only on server-remote. Admin runs on Vercel. */
/* module.exports = {
  apps: [
    {
      name: "ace-api",
      cwd: "/home/server/Apis/thomas-ai-blog/apps/api",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        API_PORT: "4010",
      },
    },
  ],
}; */

  const path = require("path");

module.exports = {
  apps: [
    {
      name: "ace-api",
      cwd: path.join(__dirname, "apps/api"),
      script: "dist/index.js",
      env: { NODE_ENV: "production", API_PORT: "4010" },
    },
    {
      name: "ace-admin",
      cwd: path.join(__dirname, "apps/admin"),
      script: "npx",
      args: "next start -p 3010",
      env: { NODE_ENV: "production" },
    },
  ],
};
