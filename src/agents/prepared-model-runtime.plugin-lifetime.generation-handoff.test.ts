import { afterEach, describe, expect, it } from "vitest";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createInspectionFixture } from "../plugins/registry-inspection.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

/**
 * Regression coverage for the `previousRegistry`-retention ownership-transfer fix
 * (`transferPluginInstanceOwner`, see `plugin-instance-scope.ts` and
 * `loader-runtime-core.ts`'s `resolvePluginRecordRetention` call site).
 *
 * Supersedes the removed `prepared-model-runtime.plugin-lifetime.disposal-successor.test.ts`,
 * `.inspection-successor.test.ts`, and `.build-resources-successor.test.ts`: those three tested
 * the now-deleted `recordPreparedPluginRegistrySuccessor`/`registrySuccessors`/
 * `retainInstancesFor` machinery, which only ever suppressed a predecessor's premature disposal
 * (ClawSweeper finding 1) and never transferred the instance into any registry's own eventual
 * disposal set (ClawSweeper finding 2, a leak). The real fix moves `owner.registry` itself
 * forward to the retaining registry the moment retention happens, so the generic
 * `owner.registry === registry` custody check every disposal path already relies on
 * (`getPluginRecordRegistry`, the inspection retire callback, `isPluginRecordActive`) is correct
 * for the whole chain without any extra bookkeeping.
 */
describe("previousRegistry-retained plugin instance ownership transfer", () => {
  it(
    "survives predecessor release, serves a real successor-side call, and disposes exactly " +
      "once once both generations retire (real PreparedModelRuntimeBuildResources worker path)",
    async () => {
      const fixture = createInspectionFixture();
      const predecessorResources = new PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      const successorResources = new PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      try {
        // Predecessor generation: scope = [fixture plugin] only, mirroring the worker's first
        // model-catalog generation.
        const predecessorRegistry = await predecessorResources.load(
          { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
          () => {},
        );
        const predecessorRecord = predecessorRegistry.plugins.find(
          (record) => record.id === fixture.plugin.id,
        );
        expect(predecessorRecord).toBeDefined();
        const instance = getPluginInstance(predecessorRecord!);
        expect(instance).toBeDefined();

        // Successor generation: scope-growth promotion over the SAME plugin id, threading the
        // predecessor through as `reusableRegistry` -- exactly what `prepareWorkerGeneration`
        // does on a fingerprint/pluginIds miss.
        const successorRegistry = await successorResources.load(
          {
            config: fixture.config,
            basePluginIds: [fixture.plugin.id],
            reusableRegistry: predecessorRegistry,
            purpose: "model-catalog",
          },
          () => {},
        );
        const successorRecord = successorRegistry.plugins.find(
          (record) => record.id === fixture.plugin.id,
        );
        expect(successorRecord).toBeDefined();
        // The successor really carried the predecessor's instance forward (incremental reuse),
        // not a freshly loaded one -- otherwise this test proves nothing.
        expect(getPluginInstance(successorRecord!)).toBe(instance);

        // Release the predecessor through the SAME path the worker actually uses: dropping the
        // `PreparedModelRuntimeBuildResources` that holds its only physical claim.
        await predecessorResources[Symbol.asyncDispose]();

        // The shared instance must not have been disposed or revoked by the predecessor's
        // release, which this fix achieves by moving `owner.registry` to the successor at
        // retention time (so the predecessor's retire filter no longer matches it at all).
        expect(instance!.disposing).toBe(false);

        // Prove an ACTUAL successor-side call succeeds, not just `disposing === false`: run a
        // real call through the instance scoped to the successor registry, the same
        // `runInRegistry` call shape `createRegistryView`/provider hook routing use internally.
        const result = instance!.runInRegistry(successorRegistry, () => "successor-call-ok");
        expect(result).toBe("successor-call-ok");

        // Now retire the successor too (terminal generation, no further successor). The shared
        // instance must be disposed exactly once -- not zero times (the leak ClawSweeper flagged
        // when disposal custody was never transferred anywhere) and not more than once.
        await successorResources[Symbol.asyncDispose]();
        expect(instance!.disposing).toBe(true);
        expect(fixture.connection(0).instanceDisposals).toBe(1);
      } finally {
        await successorResources[Symbol.asyncDispose]().catch(() => undefined);
        await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
      }
    },
  );

  it("transfers ownership through the plain acquirePluginRegistryForInspection previousRegistry path", async () => {
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // Release the predecessor's only physical claim, then the inspection itself.
      const releasePredecessor = retainPreparedPluginRegistry(predecessor.registry);
      await releasePredecessor?.();
      await predecessor.release();
      predecessor = undefined;

      expect(instance!.disposing).toBe(false);
      expect(fixture.connection(0).instanceDisposals).toBe(0);
      // A real call through the successor still works.
      expect(instance!.runInRegistry(successor.registry, () => "successor-call-ok")).toBe(
        "successor-call-ok",
      );

      await successor.release();
      successor = undefined;
      expect(fixture.connection(0).instanceDisposals).toBe(1);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("rejects a stale predecessor-only instance's call before any I/O once it is retired without a successor", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      const record = inspection.registry.plugins.find((entry) => entry.id === fixture.plugin.id);
      const instance = getPluginInstance(record!);
      expect(instance).toBeDefined();

      // Retire this generation with no successor at all (not disabled/replaced by a newer
      // generation): disposal must proceed normally, and the stale instance must then reject a
      // later call attempt before touching the database again -- the liveness fencing this fix
      // must not weaken for the ordinary, no-handoff retirement case.
      const release = retainPreparedPluginRegistry(inspection.registry);
      await release?.();
      await inspection.release();
      const released = inspection;
      inspection = undefined;

      expect(fixture.connection(0).instanceDisposals).toBe(1);
      expect(() =>
        instance!.runInRegistry(released.registry, () => {
          throw new Error("must not reach real I/O on a retired instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);
    } finally {
      await fixture.cleanup(inspection);
    }
  });

  it("rejects the old generation's authority before I/O once a plugin is disabled in the next generation", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Next generation disables the plugin entirely (not a scope-growth promotion): the record
      // is NOT retained, so `transferPluginInstanceOwner` is never called for it, and this old
      // instance must correctly reject a later call before touching real I/O once its own
      // generation retires -- liveness fencing must still hold for a replaced/disabled plugin,
      // not just for the ordinary no-handoff case the previous test covers.
      successor = await acquirePluginRegistryForInspection({
        config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
        previousRegistry: predecessor.registry,
      });
      expect(
        successor.registry.plugins.find((record) => record.id === fixture.plugin.id),
      ).toBeUndefined();

      const release = retainPreparedPluginRegistry(predecessor.registry);
      await release?.();
      await predecessor.release();
      const released = predecessor;
      predecessor = undefined;

      expect(fixture.connection(0).instanceDisposals).toBe(1);
      expect(() =>
        instance!.runInRegistry(released.registry, () => {
          throw new Error("must not reach real I/O on a disabled/retired instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("rejects stale transferred authority before I/O after transfer-then-disable", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let thirdGen: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      // 1. Load predecessor generation
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const predecessorInstance = getPluginInstance(predecessorRecord!);
      expect(predecessorInstance).toBeDefined();

      // 2. Transfer to successor via retention (transferPluginInstanceOwner called)
      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(successorRecord).toBeDefined();

      // Get the successor instance (should be same physical instance, now owned by successor registry)
      const successorInstance = getPluginInstance(successorRecord!);
      expect(successorInstance).toBeDefined();

      // 3. Disable/replace plugin in third generation
      thirdGen = await acquirePluginRegistryForInspection({
        config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
        previousRegistry: successor.registry,
      });
      expect(
        thirdGen.registry.plugins.find((record) => record.id === fixture.plugin.id),
      ).toBeUndefined();

      // Release successor retention
      const successorRelease = retainPreparedPluginRegistry(successor.registry);
      await successorRelease?.();
      await successor.release();
      const releasedSuccessor = successor;
      successor = undefined;

      // Verify the transferred-then-retired instance rejects calls before I/O
      expect(() =>
        successorInstance!.runInRegistry(releasedSuccessor.registry, () => {
          throw new Error("must not reach real I/O on a transferred-then-disabled instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);

      // Also verify the original predecessor instance still rejects (already retired)
      const predecessorRelease = retainPreparedPluginRegistry(predecessor.registry);
      await predecessorRelease?.();
      await predecessor.release();
      const releasedPredecessor = predecessor;
      predecessor = undefined;

      expect(() =>
        predecessorInstance!.runInRegistry(releasedPredecessor.registry, () => {
          throw new Error("must not reach real I/O on retired predecessor either");
        }),
      ).toThrow(PluginInstanceUnavailableError);
    } finally {
      await fixture.cleanup(thirdGen);
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });
});
