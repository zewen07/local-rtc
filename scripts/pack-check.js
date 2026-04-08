const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-rtc-pack-"));
const cacheDir = path.join(tempRoot, "npm-cache");
fs.mkdirSync(cacheDir, { recursive: true });

const result =
  process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", `npm.cmd pack --dry-run --cache ${cacheDir}`],
        {
          stdio: "inherit",
          cwd: process.cwd(),
        },
      )
    : spawnSync("npm", ["pack", "--dry-run", "--cache", cacheDir], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
