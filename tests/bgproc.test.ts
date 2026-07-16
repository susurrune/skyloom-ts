import { describe, it, expect } from "vitest";
import * as bgproc from "../src/core/bgproc";

const { getBackgroundManager } = bgproc;

const NODE = `"${process.execPath}"`;

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("bgproc · background process manager", () => {
  it("retains only the configured number of completed jobs", async () => {
    const BackgroundManager = (bgproc as any).BackgroundManager;
    expect(BackgroundManager).toBeTypeOf("function");
    const mgr = new BackgroundManager(2);
    const ids: string[] = [];

    for (let i = 0; i < 3; i++) {
      const { id } = mgr.start(`${NODE} -e "process.stdout.write('${i}')"`);
      ids.push(id!);
      expect(await waitFor(() => mgr.get(id!)?.status !== "running")).toBe(true);
    }

    expect(mgr.list()).toHaveLength(2);
    expect(mgr.get(ids[0])).toBeUndefined();
    expect(mgr.get(ids[2])).toBeDefined();
  });

  it("caps rolling logs by UTF-8 bytes instead of JavaScript characters", () => {
    const BackgroundManager = (bgproc as any).BackgroundManager;
    const mgr = new BackgroundManager();
    const job = { log: "", totalBytes: 0, trimmed: 0, readOffset: 0 };

    (mgr as any).append(job, "界".repeat(200_000));

    expect(Buffer.byteLength(job.log, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(job.totalBytes).toBe(600_000);
    expect(job.trimmed).toBeGreaterThan(0);
    expect(job.log.startsWith("�")).toBe(false);
  });

  it("runs a command to completion and captures its output", async () => {
    const mgr = getBackgroundManager();
    const { id, error } = mgr.start(`${NODE} -e "process.stdout.write('BGHELLO')"`);
    expect(error).toBeUndefined();
    expect(id).toBeTruthy();

    const done = await waitFor(() => mgr.get(id!)?.status !== "running");
    expect(done).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // let final stdout flush

    const r = mgr.read(id!);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("BGHELLO");
    expect(mgr.get(id!)?.status).toBe("exited");
  });

  it("incremental read advances the cursor (second read is empty)", async () => {
    const mgr = getBackgroundManager();
    const { id } = mgr.start(`${NODE} -e "process.stdout.write('ONCE')"`);
    await waitFor(() => mgr.get(id!)?.status !== "running");
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.read(id!).text).toContain("ONCE");
    expect(mgr.read(id!).text).toBe(""); // already consumed
  });

  it("lists jobs and kills a long-running one", async () => {
    const mgr = getBackgroundManager();
    const { id } = mgr.start(`${NODE} -e "setInterval(()=>{},1000)"`);
    expect(mgr.list().some((j) => j.id === id)).toBe(true);
    expect(mgr.get(id!)?.status).toBe("running");

    const k = mgr.kill(id!);
    expect(k.ok).toBe(true);
    const killed = await waitFor(() => mgr.get(id!)?.status === "killed");
    expect(killed).toBe(true);
  });

  it("blocks red-line commands before spawning", () => {
    const mgr = getBackgroundManager();
    const { id, error } = mgr.start("rm -rf /");
    expect(id).toBeUndefined();
    expect(error).toMatch(/BLOCKED|REDLINE/);
  });

  it("errors on read/kill of an unknown job", () => {
    const mgr = getBackgroundManager();
    expect(mgr.read("nope").ok).toBe(false);
    expect(mgr.kill("nope").ok).toBe(false);
  });
});
