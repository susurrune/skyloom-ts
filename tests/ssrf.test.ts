import { describe, it, expect, afterEach } from "vitest";
import { isPrivateIp, assertFetchAllowed } from "../src/tools/builtin";

describe("SSRF guard — isPrivateIp", () => {
  it("flags loopback, private, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.255",
                       "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
                       "::1", "::", "fc00::1", "fd12::3", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("SSRF guard — assertFetchAllowed", () => {
  afterEach(() => { delete process.env.SKYLOOM_ALLOW_PRIVATE_FETCH; });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertFetchAllowed("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(assertFetchAllowed("gopher://x")).rejects.toThrow(/scheme/);
  });
  it("rejects IP-literal private targets", async () => {
    await expect(assertFetchAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private/);
    await expect(assertFetchAllowed("http://127.0.0.1:6379/")).rejects.toThrow(/private/);
    await expect(assertFetchAllowed("http://[::1]/")).rejects.toThrow(/private/);
  });
  it("honors the opt-out env var", async () => {
    process.env.SKYLOOM_ALLOW_PRIVATE_FETCH = "1";
    await expect(assertFetchAllowed("http://127.0.0.1/")).resolves.toBeUndefined();
  });
  it("rejects an invalid URL", async () => {
    await expect(assertFetchAllowed("not a url")).rejects.toThrow(/invalid URL/);
  });
});
