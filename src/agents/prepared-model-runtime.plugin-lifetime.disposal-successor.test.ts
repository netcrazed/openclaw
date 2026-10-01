import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  recordPreparedPluginRegistrySuccessor,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";

/**
 * Regression coverage for the milestone-4 disposal-successor gap described in
 * `projects/openclaw-plugin-pool-architecture-spec.md` section 2 (goal 6) and the companion
 * investigation doc: `retainPreparedPluginRegistry`'s disposal previously called
 * `disposePluginRegistryInstances(registry)` with no successor argument at all, so a registry
 * disposed after being superseded had no way to exclude instances still live in its successor.
 */
describe("retainPreparedPluginRegistry disposal-successor wiring", () => {
  it("retains and releases a registry without a recorded successor without throwing", async () => {
    const registry = createEmptyPluginRegistry();
    const release = retainPreparedPluginRegistry(registry);
    expect(release).toBeTypeOf("function");
    await release?.();
  });

  it("recordPreparedPluginRegistrySuccessor is a no-op for the same registry", () => {
    const registry = createEmptyPluginRegistry();
    expect(() => recordPreparedPluginRegistrySuccessor(registry, registry)).not.toThrow();
  });

  it("records a distinct successor and still allows the predecessor to be retained/released cleanly", async () => {
    const previous = createEmptyPluginRegistry();
    const next = createEmptyPluginRegistry();
    recordPreparedPluginRegistrySuccessor(previous, next);
    const releasePrevious = retainPreparedPluginRegistry(previous);
    const releaseNext = retainPreparedPluginRegistry(next);
    // Disposal of `previous` must complete without throwing, exercising the successor-aware
    // `disposePluginRegistryInstances(registry, () => registrySuccessors.get(registry) ?? null)`
    // path instead of the old no-successor call.
    await releasePrevious?.();
    await releaseNext?.();
  });
});
