import { describe, it, expect, vi, beforeEach } from "vitest";
import { downloadIfMissing } from "../download";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, statSync, unlinkSync, readFileSync } from "fs";
import { execFileSync } from "child_process";

const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: after download, readFileSync returns a non-empty buffer
  mockReadFileSync.mockReturnValue(Buffer.alloc(1024));
});

describe("downloadIfMissing", () => {
  it("downloads when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockExecFileSync).toHaveBeenCalledOnce();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["-o", "/tmp/data.csv", "https://example.com/data.csv"]),
      expect.any(Object),
    );
  });

  it("skips download when file exists and is non-empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 5000 } as ReturnType<typeof statSync>);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("re-downloads when file exists but is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 } as ReturnType<typeof statSync>);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/data.csv");
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  it("includes --max-time 120 in curl arguments", () => {
    mockExistsSync.mockReturnValue(false);

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toContain("--max-time");
    expect(args).toContain("120");
  });

  it("re-downloads when statSync throws (broken symlink)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });

    downloadIfMissing("https://example.com/data.csv", "/tmp/data.csv", "test data");

    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });
});
