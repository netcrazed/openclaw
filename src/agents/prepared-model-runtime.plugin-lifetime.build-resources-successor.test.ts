import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  recordPreparedPluginRegistrySuccessor,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

/**
 * Regression coverage for the REAL model-catalog worker release path (not the bare
 * `PluginRegistryInspectionResources` path the earlier `inspection-successor.test.ts` covered).
 *
 * The worker's actual registries are always registered through
 * `PreparedModelRuntimeBuildResources.load()`, which wraps the acquired inspection resources in
 * a `PreparedRegistryResources` instance keyed into `retainPreparedModelRuntimeSnapshotResources`'s
 * backing map *before* `retainPreparedPluginRegistry` ever runs its own
 * `getPluginRegistryInspectionResources` lookup. That means `retainPreparedPluginRegistry`'s
 * `if (prepared) return prepared.release` branch is hit FIRST for every real worker registry,
 * bypassing any successor-exclusion logic placed only in the `inspection`-owned branch below it
 * (the first fix attempt) or inside `disposePluginRegistryInstances`'s successor-accessor call
 * shape further below that (the second fix attempt) -- neither of those branches is reachable
 * for this path. This test acquires a predecessor and a scope-expanded successor through the
 * exact same `PreparedModelRuntimeBuildResources.load()` + `retainPreparedPluginRegistry` flow
 * `prepareWorkerGeneration` uses (see `prepared-model-catalog.worker.ts`), records the successor
 * the same way the worker's two call sites do (before releasing the predecessor), releases the
 * predecessor through that same `prepared.release` path, and asserts the shared instance the
 * successor's copied-forward record still points at was not disposed.
 */
describe("retainPreparedPluginRegistry via PreparedModelRuntimeBuildResources (real worker path)", () => {
  it("does not dispose a predecessor's instance that a build-resources-owned successor still relies on", async () => {
    useNoBundledPlugins();
    const pluginA = writePlugin({ id: "catalog-successor-fixture-a" });
    const pluginB = writePlugin({ id: "catalog-successor-fixture-b" });
    const config = {
      plugins: {
        allow: [pluginA.id, pluginB.id],
        load: { paths: [pluginA.file, pluginB.file] },
        slots: { memory: "none" },
      },
    };

    const predecessorResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    const successorResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    try {
      // Predecessor: scope = [A] only -- mirrors the worker's first generation.
      const predecessorRegistry = await predecessorResources.load(
        { config, basePluginIds: [pluginA.id], purpose: "model-catalog" },
        () => {},
      );
      const predecessorRecord = predecessorRegistry.plugins.find(
        (record) => record.id === pluginA.id,
      );
      expect(predecessorRecord).toBeDefined();
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Successor: scope-growth promotion [A, B], threading the predecessor through as
      // `reusableRegistry` -- exactly what the worker's `prepareWorkerGeneration` does on a
      // fingerprint/pluginIds miss (`reusableRegistry: previous?.pluginGeneration.pluginRegistry`).
      const successorRegistry = await successorResources.load(
        {
          config,
          basePluginIds: [pluginA.id, pluginB.id],
          reusableRegistry: predecessorRegistry,
          purpose: "model-catalog",
        },
        () => {},
      );
      const successorRecord = successorRegistry.plugins.find((record) => record.id === pluginA.id);
      expect(successorRecord).toBeDefined();
      // Confirm the successor really carried the predecessor's instance forward (incremental
      // reuse), not a freshly loaded one -- otherwise this test would prove nothing.
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // Mirror the worker's exact sequencing: record the successor BEFORE releasing the
      // predecessor's custody.
      recordPreparedPluginRegistrySuccessor(predecessorRegistry, successorRegistry);

      // Release the predecessor through the SAME path the worker actually uses: dropping the
      // `PreparedModelRuntimeBuildResources` that holds its only physical claim.
      await predecessorResources[Symbol.asyncDispose]();

      // The instance the successor's copied-forward record still points at must survive the
      // predecessor's disposal finalizer -- this is the exact defect ClawSweeper flagged
      // (`disposePluginRegistryInstances`/the inspection retire callback calling `instance.dispose()`
      // despite a recorded successor). Matches the assertion shape the existing
      // `inspection-successor.test.ts` regression uses for the same reason: `instance.run()`
      // through this instance's *fixed* `owner` (bound once at construction to the predecessor's
      // own plugin record, not re-resolved per registry) separately gets revoked by
      // `PluginRegistryInspectionResources.release()`'s unconditional
      // `markPluginRegistriesRetired()` call -- an independent, pre-existing admission-authority
      // mechanism orthogonal to disposal that this fix does not touch (see PR comment).
      expect(instance!.disposing).toBe(false);
    } finally {
      await successorResources[Symbol.asyncDispose]();
    }
  });
});
