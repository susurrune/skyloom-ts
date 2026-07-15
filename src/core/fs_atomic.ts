import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Durably replace one file without exposing a partially-written target. */
export function atomicWriteFileSync(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  mode = 0o600,
): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(
      fd,
      data,
      typeof data === "string" ? { encoding: "utf8" } : undefined,
    );
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    try {
      fs.chmodSync(target, mode);
    } catch {
      /* best effort on Windows */
    }

    // Persist the directory entry where the platform exposes directory fsync.
    try {
      const dirFd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* unsupported on some filesystems */
    }
  } catch (error) {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}
