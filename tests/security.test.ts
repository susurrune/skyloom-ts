import { describe, it, expect } from "vitest";
import {
  DangerLevel,
  decideApproval,
  isEditTool,
  SecurityContext,
} from "../src/core/security";

describe("security · decideApproval matrix", () => {
  it("SAFE is always allowed in every mode", () => {
    for (const mode of ["auto", "interactive", "strict", "acceptEdits", "bypass"] as const) {
      expect(decideApproval(DangerLevel.SAFE, mode, "read_file")).toBe("allow");
    }
  });

  it("strict denies every non-SAFE tool", () => {
    expect(decideApproval(DangerLevel.LOW, "strict", "write_file")).toBe("deny");
    expect(decideApproval(DangerLevel.HIGH, "strict", "run_bash")).toBe("deny");
  });

  it("bypass allows everything (red-line is gated elsewhere)", () => {
    expect(decideApproval(DangerLevel.CRITICAL, "bypass", "run_bash")).toBe("allow");
    expect(decideApproval(DangerLevel.HIGH, "bypass", "deploy")).toBe("allow");
  });

  it("interactive asks for every non-SAFE tool", () => {
    expect(decideApproval(DangerLevel.LOW, "interactive", "write_file")).toBe("ask");
    expect(decideApproval(DangerLevel.HIGH, "interactive", "run_bash")).toBe("ask");
  });

  it("auto allows LOW, asks MEDIUM/HIGH, denies CRITICAL (unchanged)", () => {
    expect(decideApproval(DangerLevel.LOW, "auto", "write_file")).toBe("allow");
    expect(decideApproval(DangerLevel.MEDIUM, "auto", "git_push")).toBe("ask");
    expect(decideApproval(DangerLevel.HIGH, "auto", "run_bash")).toBe("ask");
    expect(decideApproval(DangerLevel.CRITICAL, "auto", "run_bash")).toBe("deny");
  });

  it("acceptEdits waves through edit tools but asks for other risky tools", () => {
    expect(decideApproval(DangerLevel.LOW, "acceptEdits", "write_file")).toBe("allow");
    expect(decideApproval(DangerLevel.MEDIUM, "acceptEdits", "delete_file")).toBe("allow"); // edit tool
    expect(decideApproval(DangerLevel.HIGH, "acceptEdits", "run_bash")).toBe("ask");       // not an edit
    expect(decideApproval(DangerLevel.CRITICAL, "acceptEdits", "delete_file")).toBe("deny");
  });
});

describe("security · isEditTool", () => {
  it("recognizes filesystem-mutating tools", () => {
    expect(isEditTool("write_file")).toBe(true);
    expect(isEditTool("edit_file")).toBe(true);
    expect(isEditTool("delete_file")).toBe(true);
    expect(isEditTool("move_file")).toBe(true);
    expect(isEditTool("read_file")).toBe(false);
    expect(isEditTool("run_bash")).toBe(false);
  });
});

describe("security · checkApproval integration", () => {
  it("blocks red-line shell commands regardless of mode", async () => {
    const sec = new SecurityContext({ mode: "bypass" });
    const [ok, reason] = await sec.checkApproval("run_bash", { command: "rm -rf /" }, "fog");
    expect(ok).toBe(false);
    expect(reason.toLowerCase()).toContain("red-line");
  });

  it("write_file: auto allows, strict denies, acceptEdits allows", async () => {
    const args = { path: "a.txt", content: "x" };
    expect((await new SecurityContext({ mode: "auto" }).checkApproval("write_file", args, "rain"))[0]).toBe(true);
    expect((await new SecurityContext({ mode: "strict" }).checkApproval("write_file", args, "rain"))[0]).toBe(false);
    expect((await new SecurityContext({ mode: "acceptEdits" }).checkApproval("write_file", args, "rain"))[0]).toBe(true);
  });

  it("ask defers to the approval callback", async () => {
    const sec = new SecurityContext({ mode: "interactive" });
    let asked = false;
    sec.setApprovalCallback(async () => { asked = true; return false; });
    const [ok] = await sec.checkApproval("write_file", { path: "a", content: "b" }, "rain");
    expect(asked).toBe(true);
    expect(ok).toBe(false);
  });

  it("setMode switches behavior at runtime", () => {
    const sec = new SecurityContext({ mode: "auto" });
    expect(sec.approvalMode).toBe("auto");
    sec.setMode("bypass");
    expect(sec.approvalMode).toBe("bypass");
  });
});
