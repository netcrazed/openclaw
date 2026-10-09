import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
} from "../infra/errors.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";

// Git rollback trees retain links relative to their final location. Only explicit
// dependency selection may own them; incidental plugin walks must leave them alone.
export const isPluginSourceEntry = (name: string): boolean =>
  name !== "node_modules" && name !== ".git" && !isGitRuntimeStagingName(name);

// Capture and native module hooks are synchronous; no read retains this scratch buffer.
const scratch = Buffer.allocUnsafe(64 * 1024);
const { copyFileDescriptorSync } = fsSafeAdvanced;

type CopyPluginSourceRootFileSync = (options: {
  source: { rootPath: string; absolutePath: string };
  destination: { rootPath: string; absolutePath: string };
  expectedSourceIdentity: Pick<fs.BigIntStats, "dev" | "ino">;
  clone?: "auto" | "always" | "never";
  maxBytes?: number;
  mode?: number;
  sourceHardlinks?: "allow" | "reject";
}) => {
  fd: number;
  sourceIdentity: Pick<fs.BigIntStats, "dev" | "ino">;
  [Symbol.dispose](): void;
};

function getCopyRootFileSync(): CopyPluginSourceRootFileSync | undefined {
  return (fsSafeAdvanced as { copyRootFileSync?: CopyPluginSourceRootFileSync }).copyRootFileSync;
}

export const pluginSourceStatIdentity = (
  stat: fs.BigIntStats,
  identity: Pick<fs.BigIntStats, "dev" | "ino"> = stat,
): string =>
  `${identity.dev}:${identity.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const pluginSourceIdentityChangedOnlyByCtime = (
  previous: string,
  current: string,
): boolean =>
  previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"));

function withPluginSourceFile<T>(source: string, boundary: string, read: (fd: number) => T): T {
  const opened = openRootFileSync({
    absolutePath: source,
    rootPath: boundary,
    boundaryLabel: "plugin build source",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot capture plugin source ${source}`, {
      cause: opened.error,
    });
  }
  try {
    return read(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function pluginSourceDescriptorPath(fd: number): string | undefined {
  const roots =
    process.platform === "win32"
      ? []
      : process.platform === "darwin"
        ? ["/dev/fd"]
        : ["/proc/self/fd", "/dev/fd"];
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) {
        return path.join(root, String(fd));
      }
    } catch {
      // Try the next descriptor namespace, if any.
    }
  }
  return undefined;
}

function assertPluginSourceStillAdmitted(fd: number, admitted: fs.BigIntStats): void {
  const current = fs.fstatSync(fd, { bigint: true });
  if (pluginSourceStatIdentity(current, current) !== pluginSourceStatIdentity(admitted, admitted)) {
    throw new Error(
      "Plugin source changed while preparing its reload; retry after the edit finishes.",
    );
  }
}

function copyPluginSourceFileCloneCapableSync(
  fd: number,
  admitted: fs.BigIntStats,
  target: string,
  mode: number,
): boolean {
  const descriptorPath = pluginSourceDescriptorPath(fd);
  if (!descriptorPath) {
    return false;
  }
  try {
    // COPYFILE_FICLONE asks Node/libuv to use clone/copy-on-write where the filesystem supports
    // it, while still falling back to an ordinary kernel copy when it does not. Addressing the
    // already-open descriptor through /proc/self/fd or /dev/fd keeps the admitted source identity
    // pinned; the post-copy fstat below rejects concurrent source mutation before publication.
    fs.copyFileSync(
      descriptorPath,
      target,
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
    fs.chmodSync(target, mode);
    assertPluginSourceStillAdmitted(fd, admitted);
    return true;
  } catch (error) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // Best effort; preserve the copy error or allow descriptor fallback.
    }
    // Descriptor pseudo-path support is platform/filesystem dependent. If opening the fd path
    // itself fails, keep the Windows-safe descriptor copy fallback; otherwise preserve errors
    // such as ENOSPC, EEXIST, or source mutation from the clone-capable attempt.
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}

export function pluginSourceFileIdentity(source: string, boundary: string): string {
  return withPluginSourceFile(source, boundary, (fd) =>
    pluginSourceStatIdentity(fs.fstatSync(fd, { bigint: true })),
  );
}

export function isPluginNativeExecutable(source: string, boundary: string): boolean {
  return withPluginSourceFile(source, boundary, (fd) => {
    if (fs.readSync(fd, scratch, 0, 4, 0) !== 4) {
      return false;
    }
    const magic = scratch.readUInt32BE(0);
    return (
      scratch.readUInt16BE(0) === 0x4d5a ||
      [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
        magic,
      )
    );
  });
}

export function copyPluginSourceFile(
  source: string,
  boundary: string,
  target: string,
  options: {
    hashCopiedContent?: boolean;
    preserveSourceMode?: boolean;
    copyFile?: CopyPluginSourceRootFileSync;
  } = {},
) {
  return withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    try {
      const mode = options.preserveSourceMode
        ? Number(admitted.mode & 0o777n)
        : 0o600 | Number(admitted.mode & 0o100n);
      const copyFile = options.copyFile ?? getCopyRootFileSync();
      if (copyFile) {
        // Keep our pin alive; fs-safe binds its own admitted open to this exact inode.
        using copied = copyFile({
          source: { rootPath: boundary, absolutePath: source },
          destination: { rootPath: path.dirname(target), absolutePath: target },
          expectedSourceIdentity: { dev: admitted.dev, ino: admitted.ino },
          clone: "auto",
          maxBytes: Number(admitted.size),
          mode,
          sourceHardlinks: "allow",
        });
        // The initial hash belongs to the copied descriptor; receipts still recheck its path.
        return options.hashCopiedContent
          ? {
              ...hashPluginSourceDescriptor(copied.fd),
              sourceIdentity: pluginSourceStatIdentity(admitted, copied.sourceIdentity),
            }
          : undefined;
      }

      let copied = false;
      try {
        if (!copyPluginSourceFileCloneCapableSync(fd, admitted, target, mode)) {
          const targetFd = fs.openSync(
            target,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
            mode,
          );
          try {
            copyFileDescriptorSync(fd, targetFd, {
              maxBytes: Number(admitted.size),
            });
            assertPluginSourceStillAdmitted(fd, admitted);
          } finally {
            fs.closeSync(targetFd);
          }
        }
        copied = true;
        if (!options.hashCopiedContent) {
          return undefined;
        }
        const copiedFd = fs.openSync(target, fs.constants.O_RDONLY);
        try {
          return {
            ...hashPluginSourceDescriptor(copiedFd),
            sourceIdentity: pluginSourceStatIdentity(admitted, admitted),
          };
        } finally {
          fs.closeSync(copiedFd);
        }
      } finally {
        if (!copied) {
          try {
            fs.rmSync(target, { force: true });
          } catch {
            // Best effort; the original copy failure is more useful.
          }
        }
      }
    } catch (error) {
      // fs-safe wraps native failures; retain the disk-full code and detail that
      // plugin-load diagnostics use to explain how to recover.
      if (
        error instanceof FsSafeError &&
        collectErrorGraphCandidates(error, readErrorCauses).some(
          (cause) => extractErrorCode(cause) === "ENOSPC",
        )
      ) {
        throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
          code: "ENOSPC",
        });
      }
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
          { cause: error },
        );
      }
      throw error;
    }
  });
}

export function linkPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    fs.linkSync(source, target);
    const linked = fs.statSync(target, { bigint: true });
    if (linked.dev !== admitted.dev || linked.ino !== admitted.ino) {
      throw new Error("Native plugin artifact changed during admission");
    }
  });
}

export function hashPluginSourceFile(
  source: string,
  boundary: string,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  return withPluginSourceFile(source, boundary, (fd) =>
    hashPluginSourceDescriptor(fd, receipt, prepared),
  );
}

function hashPluginSourceDescriptor(
  fd: number,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  const content = prepared ? undefined : createHash("sha256");
  const sizeBytes = prepared?.sizeBytes ?? fs.fstatSync(fd).size;
  receipt?.update(String(sizeBytes)).update("\0");
  let position = 0;
  for (;;) {
    const length = fs.readSync(
      fd,
      scratch,
      0,
      Math.min(scratch.length, sizeBytes - position + 1),
      position,
    );
    position += length;
    if (length === 0 || position > sizeBytes) {
      break;
    }
    const chunk = scratch.subarray(0, length);
    content?.update(chunk);
    receipt?.update(chunk);
  }
  if (position !== sizeBytes) {
    throw new Error(
      "Plugin source changed while preparing its reload; retry after the edit finishes.",
    );
  }
  return prepared ?? { contentHash: content!.digest("hex"), sizeBytes };
}
