import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

/** Download a file via curl if it doesn't already exist locally. */
export function downloadIfMissing(url: string, path: string, label: string): void {
  if (existsSync(path)) return;
  console.log(`Downloading ${label}...`);
  execSync(`curl -fsSL --retry 3 --connect-timeout 10 -o "${path}" "${url}"`, {
    stdio: "inherit",
  });
  const size = readFileSync(path).length;
  console.log(`  → ${(size / 1024).toFixed(0)} KB`);
}
