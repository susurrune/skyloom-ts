import { describe, it, expect } from "vitest";
import { getBackgroundManager } from "../src/core/bgproc";

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
