import { expect, test } from "bun:test";
import { createNativeGatewayRecovery } from "../src/adapters/chatgpt-web/native-gateway-recovery";

test.each([
  { platform: "linux", exists: true },
  { platform: "win32", exists: false },
])("gateway recovery fails closed without source checkout capability: %j", async capability => {
  let starts = 0;
  const recover = createNativeGatewayRecovery({
    platform: capability.platform, scriptExists: () => capability.exists,
    run: async () => { starts += 1; },
  });
  await expect(recover()).rejects.toThrow("Windows source checkout");
  expect(starts).toBe(0);
});

test.each([false, true])("gateway recovery shares one flight and clears it after failure=%s", async fails => {
  let starts = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const recover = createNativeGatewayRecovery({
    platform: "win32", scriptExists: () => true,
    run: async () => { starts += 1; await gate; if (fails) throw new Error("unhealthy"); },
  });
  const first = recover();
  const second = recover();
  expect(first).toBe(second);
  await Promise.resolve();
  expect(starts).toBe(1);
  finish();
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes.map(result => result.status)).toEqual([fails ? "rejected" : "fulfilled", fails ? "rejected" : "fulfilled"]);
  await Promise.allSettled([recover()]);
  expect(starts).toBe(2);
});
