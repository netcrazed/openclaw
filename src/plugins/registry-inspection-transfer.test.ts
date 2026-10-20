import { afterEach, expect, it } from "vitest";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { resetPluginLoaderTestStateForTest, writePlugin } from "./loader.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import { createInspectionFixture } from "./registry-inspection.test-helpers.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

it("keeps predecessor resources through abandoned growth and transfers them only at promotion", async () => {
  const fixture = createInspectionFixture();
  const newcomer = writePlugin({ id: "inspection-growth", registration: "" });
  const config = {
    plugins: {
      ...fixture.config.plugins,
      allow: [...fixture.config.plugins.allow, newcomer.id],
      load: { paths: [...fixture.config.plugins.load.paths, newcomer.file] },
    },
  };
  const previous = await acquirePluginRegistryForInspection({ config: fixture.config });
  let pending: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
  try {
    const record = previous.registry.plugins.find(({ id }) => id === fixture.plugin.id)!;
    const instance = getPluginInstance(record)!;
    const current = capturePluginLifecycleAuthority(previous.registry, record, {
      scopedRuntime: true,
    });
    expect(current?.()).toBe(true);
    const read = () => fixture.connection().database.prepare("SELECT 42 AS value").get();
    pending = await acquirePluginRegistryForInspection({
      config,
      previousRegistry: previous.registry,
    });
    expect(pending.registry.plugins).toContain(record);
    await pending.release();
    pending = undefined;
    expect(instance.runInRegistry(previous.registry, read)).toMatchObject({ value: 42 });
    expect(fixture.connection().disposals).toBe(0);
    expect(fixture.connection().instanceDisposals).toBe(0);

    pending = await acquirePluginRegistryForInspection({
      config,
      previousRegistry: previous.registry,
    });
    getPluginRegistryInspectionResources(pending.registry)!.adoptRetainedRegistrations(
      previous.registry,
    );
    await previous.release();
    expect(current?.()).toBe(true);
    expect(
      capturePluginLifecycleAuthority(previous.registry, record, { scopedRuntime: true }),
    ).toBeUndefined();
    expect(instance.runInRegistry(pending.registry, read)).toMatchObject({ value: 42 });
    expect(fixture.connection().disposals).toBe(0);
    expect(fixture.connection().instanceDisposals).toBe(0);
    await pending.release();
    pending = undefined;
    expect(current?.()).toBe(false);
    expect(fixture.connection().disposals).toBe(1);
    expect(fixture.connection().instanceDisposals).toBe(1);
  } finally {
    await fixture.cleanup(pending);
    await fixture.cleanup(previous);
  }
});
