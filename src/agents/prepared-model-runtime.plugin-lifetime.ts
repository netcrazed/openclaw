import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginMetadataSnapshotCache,
  getPluginCacheRetirementSignal,
  retainPluginCache,
  waitForPluginCacheRetirement,
} from "../plugins/plugin-cache.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import {
  bindPluginRegistryLifetime,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginRegistryLifetime,
  getPluginRegistryGatewayOwner,
  getPluginRegistryResourceOwner,
  markPluginRegistryActive,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  hasRetainedPluginRuntimeCloseError,
  PluginRuntimeCloseRetainedError,
} from "../plugins/runtime-close-error.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PreparedModelRuntimePluginGenerationRetiredError } from "./prepared-model-runtime.errors.js";
import {
  registerPreparedPluginRetirement,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";
import {
  closeEphemeralPreparedModelRuntimeResources,
  retainPreparedModelRuntimeSnapshotResources,
} from "./prepared-model-runtime.resources.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { releaseRuntimePluginWork, retainRuntimePluginWork } from "./runtime-plugin-work.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
type Lifetime = ReturnType<typeof createLifetime>;
// Source and compiled consumers can share the same generation and registry objects.
// Share only cleanup ownership; model/auth snapshots keep their existing module identity.
const { generations, active, retirements, publications, registrySuccessors } =
  resolveGlobalSingleton(Symbol.for("openclaw.preparedPluginLifetimes"), () => ({
    generations: new WeakMap<PreparedModelRuntimePluginGeneration, Lifetime>(),
    active: new Set<Lifetime>(),
    retirements: new Set<Promise<void>>(),
    publications: new WeakMap<object, { release: () => Promise<void> }>(),
    // Milestone 4 (plugin pool spec, disposal-successor gap): when a registry is superseded by
    // a newer one (e.g. the model-catalog worker promoting a scope-expanded build over its
    // predecessor), record the successor here *before* the predecessor's refcount can reach
    // zero. Disposal then excludes any instance still live in that successor, matching the same
    // `retained` contract the Gateway's own reload path (`server-plugin-reload-cleanup.ts`) has
    // always supplied to `disposePluginRegistryInstances`. Without this, a registry disposed
    // while a successor still references shared plugin instances can tear down state the
    // successor is actively relying on.
    registrySuccessors: new WeakMap<PluginRegistry, PluginRegistry>(),
  }));

/**
 * Record that `next` supersedes `previous` for disposal purposes. Call this BEFORE releasing
 * custody of `previous` whenever a successor registry is promoted over it (see
 * `prepared-model-catalog.worker.ts`'s generation-promotion path for the first caller). Safe to
 * call even if `previous` never ends up retired through `retainPreparedPluginRegistry`.
 */
export function recordPreparedPluginRegistrySuccessor(
  previous: PluginRegistry,
  next: PluginRegistry,
): void {
  if (previous === next) {
    return;
  }
  const previousOwner = getPluginRegistryResourceOwner(previous);
  const nextOwner = getPluginRegistryResourceOwner(next);
  if (previousOwner === nextOwner) {
    return;
  }
  registrySuccessors.set(previousOwner, nextOwner);
}

function createLifetime(dispose: () => Promise<unknown>, retainWork?: () => () => void) {
  const cleanupWork = new AsyncWorkScope();
  const references = new Set<object>();
  let closing: Deferred | undefined;
  let disposing = false;
  const lifetime = {
    get referenced() {
      return references.size > 0;
    },
    retain(work = false) {
      if (closing) {
        throw new PreparedModelRuntimePluginGenerationRetiredError(
          "Prepared plugin generation has retired",
        );
      }
      const releaseWork = work ? retainWork?.() : undefined;
      const reference = {};
      references.add(reference);
      let releaseCompletion: Promise<void> | undefined;
      return () => {
        if (references.delete(reference)) {
          const completion = references.size === 0 ? lifetime.close() : undefined;
          releaseCompletion = releaseWork
            ? releaseRuntimePluginWork(() => completion, releaseWork)
            : completion;
        }
        return releaseCompletion;
      };
    },
    close(): Promise<void> {
      if (!closing) {
        const completion = (closing = createDeferredCore());
        retirements.add(completion.promise);
        void completion.promise.then(
          () => {
            active.delete(lifetime);
            retirements.delete(completion.promise);
          },
          (error: unknown) => {
            // Keep the rejected completion for observation, not as ordinary resource custody.
            if (!hasRetainedPluginRuntimeCloseError(error)) {
              active.delete(lifetime);
            }
          },
        );
      }
      if (references.size === 0 && !disposing) {
        disposing = true;
        const completion = closing;
        // A catalog lease can outlive its requesting RPC; this lifetime owns its cleanup.
        void (async () => {
          try {
            await cleanupWork.track(dispose);
          } finally {
            await cleanupWork.run(() => cleanupWork.drain());
          }
        })().then(() => completion.resolve(), completion.reject);
      }
      return closing.promise;
    },
  };
  active.add(lifetime);
  return lifetime;
}

/** Retain physical registry custody for construction or publication, independent of active work. */
export function retainPreparedPluginRegistry(
  registryView: PluginRegistry,
): (() => void | Promise<void>) | undefined {
  registerPreparedPluginLifetime();
  // Milestone 4 fix (disposal-successor gap, real worker path): both of the worker's call sites
  // (`prepared-model-catalog.worker.ts`) capture a predecessor's release closure from an EARLIER
  // call to this function, then call `recordPreparedPluginRegistrySuccessor` only once the
  // successor exists -- strictly AFTER this function already returned for the predecessor.
  // Resolving the successor eagerly here (the first two fix attempts, in whichever branch) can
  // therefore never see it: `registrySuccessors` is always empty for the predecessor at the time
  // this function itself runs. The exclusion has to be resolved lazily, inside the returned
  // release closure, at the moment it is actually invoked -- which happens after the successor
  // has been recorded. All three branches below (`prepared`, bare `inspection`, and the
  // `createLifetime`-owned path) ultimately bottom out in the same `PluginRegistryInspectionResources`
  // instance's claim refcount reaching zero and invoking its `retire` callback (see
  // `acquireRegistryResources` in `plugins/loader-runtime-load.ts`), which is the only place that
  // actually calls `instance.dispose()` and the only place that consults `retainedInstances`.
  // Wrapping each branch's release closure to resolve+apply the successor exclusion just before
  // delegating to the real release is therefore correct and timing-safe for every real owner
  // shape, including the worker's actual `PreparedModelRuntimeBuildResources`-wrapped path.
  const owner = getPluginRegistryResourceOwner(registryView);
  const inspection = getPluginRegistryInspectionResources(registryView);
  const applySuccessorExclusion = (): void => {
    const successor = registrySuccessors.get(owner);
    if (successor && inspection) {
      inspection.retainInstancesFor(successor);
    }
  };
  const prepared = retainPreparedModelRuntimeSnapshotResources({ pluginRegistry: registryView });
  if (prepared) {
    return () => {
      applySuccessorExclusion();
      return prepared.release();
    };
  }
  if (inspection) {
    const release = inspection.retain().release;
    return () => {
      applySuccessorExclusion();
      return release();
    };
  }
  const registry = owner;
  let lifetime = getPluginRegistryLifetime(registry);
  if (!lifetime) {
    // Gateway-root and other externally activated registries remain borrowed.
    if (capturePluginRegistryLifecycleEpoch(registry)) {
      return undefined;
    }
    if (isPluginRegistryRetired(registry)) {
      throw new PreparedModelRuntimePluginGenerationRetiredError(
        "Prepared plugin registry has retired",
      );
    }
    markPluginRegistryActive(registry);
    lifetime = createLifetime(async () => {
      try {
        // Milestone 4 fix: supply the successor accessor so disposal excludes any instance
        // still referenced by a registry that has since superseded this one (e.g. the
        // model-catalog worker's scope-expansion promotion). Mirrors the Gateway reload path's
        // own `disposePluginRegistryInstances(registry, previousRegistry)` call shape.
        return await disposePluginRegistryInstances(
          registry,
          () => registrySuccessors.get(registry) ?? null,
        );
      } catch (error) {
        // Ordinary cleanup faults are result rows; rejection leaves a host prerequisite unfinished.
        throw new PluginRuntimeCloseRetainedError(error);
      }
    });
    bindPluginRegistryLifetime(registry, lifetime);
  }
  return lifetime.retain();
}

/** Construction registers the same final owner before an awaited inspection can finish. */
export function registerPreparedPluginLifetime(): void {
  registerPreparedPluginRetirement(closePreparedPluginGenerations);
}

export function ownPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): Lifetime {
  const existing = generations.get(generation);
  if (existing) {
    return existing;
  }
  registerPreparedPluginLifetime();
  const releaseMetadata = retainPluginCache(
    getPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot),
  );
  const releases: Array<() => void | Promise<void>> = [];
  const selectedRegistries = new Set(
    [generation.pluginRegistry, generation.inboundPluginRegistry].filter(
      (registry) => registry !== undefined,
    ),
  );
  const acquisitionFailures: unknown[] = [];
  const lifetime = createLifetime(
    async () => {
      const results = await Promise.allSettled(releases.map(async (release) => await release()));
      releaseMetadata();
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(
          [...acquisitionFailures, ...failures],
          "Prepared plugin generation cleanup failed",
        );
      }
    },
    () => retainRuntimePluginWork(selectedRegistries),
  );
  try {
    for (const registry of selectedRegistries) {
      const release = retainPreparedPluginRegistry(registry);
      if (release) {
        releases.push(release);
      }
    }
  } catch (error) {
    // The same terminal owner joins partial acquisition, including both failure causes.
    acquisitionFailures.push(error);
    void lifetime.close().catch(() => {});
    throw error;
  }
  generations.set(generation, lifetime);
  return lifetime;
}

export function retainPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): () => Promise<void> {
  const release = ownPreparedPluginGeneration(generation).retain(true);
  return async () => {
    await release();
  };
}

/** Publishing replaces one reference, while admitted leases retain their exact generation. */
export function publishPreparedPluginGeneration(
  owner: PreparedModelRuntimeOwner,
  generation: PreparedModelRuntimePluginGeneration,
): void {
  const previous = publications.get(owner);
  const instances = new Set(
    [generation.pluginRegistry, generation.inboundPluginRegistry].flatMap((registry) =>
      registry
        ? [...collectRegistryInvocationInstances(registry)].filter(
            (instance) => !instance.owner || instance.owner.record.status === "loaded",
          )
        : [],
    ),
  );
  const cacheSignal = getPluginCacheRetirementSignal(
    getPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot),
  );
  const isCurrent = () =>
    !cacheSignal.aborted && [...instances].every((instance) => instance.acceptingCalls);
  if (!isCurrent()) {
    throw new PreparedModelRuntimePluginGenerationRetiredError(
      "Prepared plugin generation retired before publication",
    );
  }
  const release = ownPreparedPluginGeneration(generation).retain();
  const version = owner.generation;
  const gatewayLenders = new Set<PluginRegistry>();
  let signal: AbortSignal | undefined;
  const unsubscribe = () => signal?.removeEventListener("abort", observe);
  const observe = () => {
    unsubscribe();
    if (!isCurrent()) {
      // A cached publication cannot keep a closing Gateway's donor alive. Admitted
      // leases retain the same generation independently until their work finishes.
      if (owner.generation === version) {
        owner.generation++;
        retirePreparedModelRuntimeGeneration(owner);
        owner.needsRefresh = true;
        owner.refreshError = new PreparedModelRuntimePluginGenerationRetiredError(
          "Prepared model runtime plugin generation retired",
        );
        owner.pluginGeneration = undefined;
        const retiredGatewayLoan = [...instances].some(
          (instance) =>
            !instance.acceptingCalls &&
            instance.owner !== undefined &&
            gatewayLenders.has(instance.owner.registry),
        );
        releasePreparedPluginPublication(owner);
        // Independent prepared instances and metadata caches retain their terminal
        // retirement contract; only a lost Gateway loan needs process publication.
        if (retiredGatewayLoan) {
          owner.onPluginGenerationRetired?.();
        }
        return;
      }
      releasePreparedPluginPublication(owner);
      return;
    }
    // Publication can transfer an unchanged instance before aborting its old registry
    // epoch. Follow its new owner so a later real retirement remains observable.
    gatewayLenders.clear();
    signal = AbortSignal.any([
      cacheSignal,
      ...[...instances].flatMap((instance) => {
        const registry = instance.owner?.registry;
        // A turn registry can carry its admitting Gateway without being its lender.
        // Capture physical custody while the Gateway owner still admits work.
        if (registry && getPluginRegistryGatewayOwner(registry)?.current() === registry) {
          gatewayLenders.add(registry);
        }
        const current =
          registry &&
          capturePluginRegistryLifecycleSignal(
            registry,
            capturePluginRegistryLifecycleEpoch(registry),
            { scopedRuntime: true },
          );
        return current ? [current] : [];
      }),
    ]);
    signal.addEventListener("abort", observe, { once: true });
  };
  publications.set(owner, {
    release: () => {
      unsubscribe();
      return Promise.resolve(release());
    },
  });
  observe();
  void previous?.release()?.catch(() => {});
}

export function releasePreparedPluginPublication(owner: object): void {
  const previous = publications.get(owner);
  publications.delete(owner);
  void previous?.release()?.catch(() => {});
}

/** Failed unpublished builds release only their own generations, never a sibling's cache. */
export async function discardPreparedPluginGeneration(
  generation: PreparedModelRuntimePluginGeneration,
): Promise<void> {
  const lifetime = generations.get(generation);
  if (lifetime && !lifetime.referenced) {
    await lifetime.close();
  }
}

/** Process shutdown owns every outstanding generation and any earlier cleanup failure. */
async function closePreparedPluginGenerations(): Promise<void> {
  const resourcesClosed = Promise.allSettled([closeEphemeralPreparedModelRuntimeResources()]);
  const pending = new Set([...active].map((lifetime) => lifetime.close()));
  for (const completion of retirements) {
    pending.add(completion);
  }
  // Consume this observation before yielding; later retirements keep their own observer.
  for (const completion of pending) {
    retirements.delete(completion);
  }
  const results = await Promise.allSettled(pending);
  results.push(...(await resourcesClosed));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  let retained = failures.some(hasRetainedPluginRuntimeCloseError);
  try {
    await waitForPluginCacheRetirement(true);
  } catch (reason) {
    retained = true;
    failures.push(reason);
  }
  if (retained) {
    throw new AggregateError(failures, "Prepared plugin generations failed to close");
  }
  if (failures.length) {
    log.warn(
      formatErrorMessage(
        new AggregateError(failures, "Prepared plugin cleanup completed with failures"),
      ),
    );
  }
}
