import { afterEach, describe, expect, it } from "vitest";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createInspectionFixture } from "../plugins/registry-inspection.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  recordPreparedPluginRegistrySuccessor,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

/**
 * Regression coverage for the inspection-early-return disposal-successor bypass:
 * `retainPreparedPluginRegistry` (prepared-model-runtime.plugin-lifetime.ts) returns through
 * `getPluginRegistryInspectionResources(registryView)`'s early return for inspection-owned
 * registries (the model-catalog worker's registries always are, via
 * `acquirePluginRegistryForInspection`) *before* ever reaching the `registrySuccessors`-aware
 * `disposePluginRegistryInstances` call a few lines below. Without excluding the successor's
 * live instances from that inspection's own finalizer (`loader-runtime-load.ts`'s
 * `acquireRegistryResources` retire callback), releasing a predecessor registry after a
 * scope-growth promotion disposes plugin instances the successor's copied-forward records still
 * point at -- a use-after-dispose for any subsequent provider-hook call made through the
 * successor.
 */
describe("retainPreparedPluginRegistry inspection-owned successor exclusion", () => {
  it("does not dispose a predecessor's plugin instance that a recorded successor still relies on", async () => {
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      // Predecessor registry: A (the fixture plugin) only.
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(predecessorRecord).toBeDefined();
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Successor registry: scope-growth promotion that reuses the predecessor's loaded
      // instance via `previousRegistry` (this is what `loadOpenClawPluginsCore` does for the
      // model-catalog worker's A+B -> A+B+C promotion).
      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(successorRecord).toBeDefined();
      // Confirm the successor's record really is the copied-forward instance, not a fresh one.
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // Mirror the worker's exact sequencing: record the successor BEFORE releasing the
      // predecessor's custody.
      recordPreparedPluginRegistrySuccessor(predecessor.registry, successor.registry);

      // Take and release the only physical claim retainPreparedPluginRegistry hands out for an
      // inspection-owned registry, then fully release the predecessor inspection -- this is the
      // path that disposes the predecessor's instances once its last claim drops.
      const releasePredecessor = retainPreparedPluginRegistry(predecessor.registry);
      await releasePredecessor?.();
      await predecessor.release();
      predecessor = undefined;

      // The instance the successor still relies on must not have been disposed.
      expect(instance!.disposing).toBe(false);
      expect(fixture.connection(0).instanceDisposals).toBe(0);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });
});
