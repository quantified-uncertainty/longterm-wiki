import { readFileSync, existsSync, statSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";

/** Download a file via curl if it doesn't already exist locally. */
export function downloadIfMissing(url: string, path: string, label: string): void {
  if (existsSync(path)) {
    try {
      if (statSync(path).size > 0) return;
    } catch {
      // Broken symlink, permission error, etc. — re-download
    }
    try { unlinkSync(path); } catch { /* already gone */ }
  }
  console.log(`Downloading ${label}...`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "10", "-o", path, url], {
    stdio: "inherit",
  });
  const size = readFileSync(path).length;
  console.log(`  → ${(size / 1024).toFixed(0)} KB`);
}
