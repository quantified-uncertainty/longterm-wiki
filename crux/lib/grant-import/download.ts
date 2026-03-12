import { readFileSync, existsSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";

/** Download a file via curl if it doesn't already exist locally. */
export function downloadIfMissing(url: string, path: string, label: string): void {
  if (existsSync(path)) {
    const fileSize = statSync(path).size;
    if (fileSize > 0) return;
    // Empty file from interrupted download — remove and re-download
    console.warn(`Found empty file at ${path}, re-downloading...`);
    unlinkSync(path);
  }
  console.log(`Downloading ${label}...`);
  execSync(`curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 -o "${path}" "${url}"`, {
    stdio: "inherit",
  });
  const size = readFileSync(path).length;
  console.log(`  → ${(size / 1024).toFixed(0)} KB`);
}
