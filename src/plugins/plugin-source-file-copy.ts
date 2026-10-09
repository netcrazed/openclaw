import fs from "node:fs";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";

type FileIdentity = Pick<fs.BigIntStats, "dev" | "ino">;
type PluginSourceDescriptorHash = (fd: number) => { contentHash: string; sizeBytes: number };
type PluginSourceIdentityFormatter = (stat: fs.BigIntStats, identity?: FileIdentity) => string;

export function hasKnownPluginFileIdentity(identity: FileIdentity): boolean {
  return identity.dev !== 0n && identity.ino !== 0n;
}

function sameKnownIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasKnownPluginFileIdentity(left) && left.dev === right.dev && left.ino === right.ino;
}

function assertPluginSourceStillAdmitted(params: {
  fd: number;
  admitted: fs.BigIntStats;
  sourceIdentity: string;
  formatIdentity: PluginSourceIdentityFormatter;
}): void {
  const current = fs.fstatSync(params.fd, { bigint: true });
  if (params.formatIdentity(current, current) === params.sourceIdentity) {
    return;
  }
  throw new Error(
    "Plugin source changed while preparing its reload; retry after the edit finishes.",
  );
}

function assertOwnedPluginCopyTargetCurrent(
  fd: number,
  target: string,
  identity: FileIdentity,
): void {
  const current = fs.fstatSync(fd, { bigint: true });
  const named = fs.statSync(target, { bigint: true });
  if (!sameKnownIdentity(current, identity) || !sameKnownIdentity(named, identity)) {
    throw new FsSafeError("path-mismatch", "copy destination changed");
  }
}

function removeOwnedPluginCopyTargetIfCurrent(target: string, identity: FileIdentity): void {
  if (!hasKnownPluginFileIdentity(identity)) {
    return;
  }
  try {
    if (sameKnownIdentity(fs.statSync(target, { bigint: true }), identity)) {
      fs.rmSync(target, { force: true });
    }
  } catch {
    // Preserve the primary copy failure; never follow replacements during cleanup.
  }
}

export function copyPluginSourceFileDescriptorGuardedSync(params: {
  fd: number;
  admitted: fs.BigIntStats;
  sourceIdentity: string;
  target: string;
  mode: number;
  hashCopiedContent?: boolean;
  hashDescriptor: PluginSourceDescriptorHash;
  formatIdentity: PluginSourceIdentityFormatter;
}) {
  const targetOwner = fsSafeAdvanced.createFileSync(params.target, { mode: 0o600 });
  const identity = fs.fstatSync(targetOwner.fd, { bigint: true });
  let completed = false;
  try {
    fsSafeAdvanced.copyFileDescriptorSync(params.fd, targetOwner.fd, {
      maxBytes: Number(params.admitted.size),
    });
    assertPluginSourceStillAdmitted(params);
    assertOwnedPluginCopyTargetCurrent(targetOwner.fd, params.target, identity);
    fs.fchmodSync(targetOwner.fd, params.mode);
    assertOwnedPluginCopyTargetCurrent(targetOwner.fd, params.target, identity);
    completed = true;
    return params.hashCopiedContent
      ? {
          ...params.hashDescriptor(targetOwner.fd),
          sourceIdentity: params.formatIdentity(params.admitted, params.admitted),
        }
      : undefined;
  } finally {
    try {
      targetOwner.close();
    } finally {
      if (!completed) {
        removeOwnedPluginCopyTargetIfCurrent(params.target, identity);
      }
    }
  }
}

export function canUseDescriptorGuardedCopyFallback(error: unknown): boolean {
  if (process.platform !== "win32" || !(error instanceof FsSafeError)) {
    return false;
  }
  return (
    error.code === "path-mismatch" ||
    error.code === "helper-failed" ||
    error.code === "unsupported-platform"
  );
}
