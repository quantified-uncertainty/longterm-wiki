import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadIfMissing } from "../download";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { existsSync, statSync, unlinkSync, readFileSync } from "fs";
import { execSync } from "child_process";

const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: after download, readFileSync returns a non-empty buffer
  mockReadFileSync.mockReturnValue(Buffer.alloc(1024));
});

describe("downloadIfMissing", () => {
  it("downloads when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("curl"),
      expect.any(Object),
    );
  });

  it("skips download when file exists and is non-empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 5000 } as ReturnType<typeof statSync>);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("re-downloads when file exists but is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 } as ReturnType<typeof statSync>);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/data.csv");
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("includes --max-time 120 in curl command", () => {
    mockExistsSync.mockReturnValue(false);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    const curlCmd = mockExecSync.mock.calls[0][0] as string;
    expect(curlCmd).toContain("--max-time 120");
  });
});
