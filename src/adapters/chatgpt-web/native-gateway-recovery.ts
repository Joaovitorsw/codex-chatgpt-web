import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const recoveryScript = resolve(import.meta.dir, "../../../scripts/recover-native-gateway.ps1");

export function createNativeGatewayRecovery(options: {
  platform: string;
  scriptExists: () => boolean;
  run: () => Promise<void>;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (options.platform !== "win32" || !options.scriptExists()) {
      return Promise.reject(new Error("Native gateway recovery requires a Windows source checkout"));
    }
    pending ??= Promise.resolve().then(options.run).finally(() => { pending = undefined; });
    return pending;
  };
}

function runRecoveryScript(): Promise<void> {
  return new Promise((resolveRecovery, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", recoveryScript], {
      cwd: resolve(import.meta.dir, "../../.."), windowsHide: true, timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Drain both pipes without retaining or publishing configuration or authentication details.
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => reject(new Error("Native gateway recovery process could not start")));
    child.once("close", code => {
      if (code === 0) resolveRecovery();
      else reject(new Error("Native gateway recovery did not verify health"));
    });
  });
}

export const recoverNativeGateway = createNativeGatewayRecovery({
  platform: process.platform,
  scriptExists: () => existsSync(recoveryScript),
  run: runRecoveryScript,
});
