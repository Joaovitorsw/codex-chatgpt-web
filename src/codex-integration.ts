import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import {
  installCodexInterruptHook,
  installCodexInterruptHookCommand,
  MANAGED_INTERRUPT_HOOK_END,
  MANAGED_INTERRUPT_HOOK_START,
  restoreOrphanedCodexInterruptHook,
} from "./codex-interrupt-hook";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  MANAGED_COMMENT,
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
  MANAGED_ROUTE_COMMENT,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeFileSnapshot,
  writeFilesWithCompensation,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  findTopLevelAssignment,
  installCompatibilityV1Features,
  parseDocument,
  removeDocumentLine,
  removeManagedComment,
  renderDocument,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertBuiltinModelProvider,
  assertPreservedPreviousAssignments,
  assertPreservedPreviousRealtimeAssignment,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
  );
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(route.text);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : route;
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(), config.interruptHookCommand)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(), config);
  return { ...configured, text: hook.text, interruptHook: hook.installed };
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 || journal.version === 10
    ? journal.installed.subagent_protocol
    : "native";
}

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
): AppConfig["subagentProtocol"] {
  const journal = readJournal();
  return journal?.version === 8 || journal?.version === 9 || journal?.version === 10
    ? journal.installed.subagent_protocol
    : fallback;
}

export function setCodexSubagentProtocol(
  config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  const status = inspectCodexIntegration();
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const nextConfig = { ...config, subagentProtocol: protocol };
  // The runtime catalog and Codex feature surface are two halves of one protocol selection. If
  // either write fails, restore every participant so the next launcher/Codex restart cannot load a
  // split V1/V2 state.
  const snapshots = [
    getConfigPath(),
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => snapshotFile(path, { followSymlink: path === getCodexConfigPath() }));
  try {
    const journal = installCodexIntegration(nextConfig);
    saveConfig(nextConfig);
    return journal;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; subagent protocol rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const configSnapshot = snapshotFile(configPath, { followSymlink: true });
  const configExists = configSnapshot.exists;
  const currentText = configSnapshot.data?.toString("utf8") ?? "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      installConfiguredRoute("", installedUrl, config, true, true);
      return;
    }
    try {
      verifyManagedJournalState(currentText, existing);
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      installConfiguredRoute(
        replacementBaseline(currentText, configExists, existing),
        installedUrl,
        config,
        true,
        true,
      );
      return;
    }
    if (existing.version === 10) {
      assertBuiltinModelProvider(currentText);
      return;
    }
    const baseline = managedJournalIsActive(existing)
      ? restoreManagedRoute(currentText, existing)
      : currentText;
    installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      options.replaceExistingRoute === true,
    );
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  } else if (hasJournalIndependentManagedEvidence(currentText)) {
    baseline = stripJournalIndependentManagedArtifacts(currentText, configPath, { removeWebModel: false }).text;
  }
  installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedJournalState(currentText, existing);
      baseline = managedJournalIsActive(existing)
        ? restoreManagedRoute(currentText, existing)
        : currentText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || existing.version === 10 || options.replaceExistingRoute === true,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      if (existing.version === 9 || existing.version === 10) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 10,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        subagent_protocol: config.subagentProtocol,
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      previousRealtimeWebrtcCallBaseUrl: preservePrevious && (existing.version === 9 || existing.version === 10)
        ? existing.previousRealtimeWebrtcCallBaseUrl
        : patched.previousRealtimeWebrtcCallBaseUrl,
      interruptHook: patched.interruptHook,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    writeIntegrationState(updated, { path: configPath, data: patched.text }, [getCodexModelsCachePath()]);
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  } else if (hasJournalIndependentManagedEvidence(currentText)) {
    baseline = stripJournalIndependentManagedArtifacts(currentText, configPath, { removeWebModel: false }).text;
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
  const journal: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: config.subagentProtocol,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
    },
    previous: patched.previous,
    previousRealtimeWebrtcCallBaseUrl: patched.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: patched.interruptHook,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  writeIntegrationState(journal, { path: configPath, data: patched.text }, [getCodexModelsCachePath()]);
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  // A previous launcher may have restored config.toml successfully and exited before
  // persisting active:false to both journals. If the complete previous configuration is
  // already present, reconcile the journal instead of treating our own restoration as a
  // conflicting user edit.
  if (existing.version === 4 || existing.version === 5 || existing.version === 6
    || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) {
    try {
      verifyRestoredRoute(current, existing);
      const reconciled = { ...existing, active: false };
      writeIntegrationState(reconciled, { path: existing.configPath, data: current }, [getCodexModelsCachePath()]);
      return { changed: true, active: false };
    } catch {
      // Shutdown can be interrupted after restoring only part of the owned route. Strip
      // any fragments that still match this journal, then require the complete previous
      // state to verify. A newer user value survives replacementBaseline and fails this
      // verification, preserving the conflict protection.
      const recovered = replacementBaseline(current, true, existing);
      try {
        verifyRestoredRoute(recovered, existing);
        const reconciled = { ...existing, active: false };
        writeIntegrationState(reconciled, { path: existing.configPath, data: recovered }, [getCodexModelsCachePath()]);
        return { changed: true, active: false };
      } catch {
        // Continue through the original strict error path below.
      }
    }
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV9
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 10 && existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const hookConfig = existing.version === 10
    ? { interruptHookCommand: existing.interruptHook.command }
    : { runtimeCommand: loadConfig().runtimeCommand };
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { subagentProtocol: protocol, ...hookConfig },
    true,
    existing.version === 9 || existing.version === 10,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  if (existing.version === 9 || existing.version === 10) {
    assertPreservedPreviousRealtimeAssignment(
      route.previousRealtimeWebrtcCallBaseUrl,
      existing.previousRealtimeWebrtcCallBaseUrl,
    );
  }
  const connected: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: protocol,
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
    },
    previous: existing.previous,
    previousRealtimeWebrtcCallBaseUrl: existing.version === 9 || existing.version === 10
      ? existing.previousRealtimeWebrtcCallBaseUrl
      : route.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: route.interruptHook,
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(connected, { path: existing.configPath, data: route.text }, [getCodexModelsCachePath()]);
  return { changed: true, active: true };
}

export interface RestoreNativeCodexResult {
  changed: boolean;
  backupPath?: string;
  conflicts: string[];
}

function managedBridgeUrl(
  value: string | undefined,
  ownedEvidence: boolean,
  allowDefaultPort: boolean,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const defaultPort = url.port === "17841";
    return url.protocol === "http:" && loopback && /^\/v1\/?$/.test(url.pathname)
      && (ownedEvidence || (allowDefaultPort && defaultPort));
  } catch {
    return false;
  }
}

function hasJournalIndependentManagedEvidence(text: string): boolean {
  return text.includes(MANAGED_INTERRUPT_HOOK_START)
    || text.includes(MANAGED_INTERRUPT_HOOK_END)
    || splitLines(text).some(line => line === MANAGED_ROUTE_COMMENT || line === MANAGED_COMMENT);
}

function stripJournalIndependentManagedArtifacts(
  input: string,
  configPath: string,
  options: {
    removeWebModel?: boolean;
    removeBridgeWithoutEvidence?: boolean;
  } = {},
): { text: string; conflicts: string[] } {
  let text = input;
  const conflicts: string[] = [];
  const hookStartCount = text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
  const hookEndCount = text.split(MANAGED_INTERRUPT_HOOK_END).length - 1;
  const ownedHook = hookStartCount > 0 || hookEndCount > 0;
  if (ownedHook) text = restoreOrphanedCodexInterruptHook(text, configPath);

  const document = parseDocument(text);
  const routeMarkerCount = document.lines.filter(line =>
    line === MANAGED_ROUTE_COMMENT || line === MANAGED_COMMENT).length;
  if (routeMarkerCount > 1) {
    throw new Error("Codex config contains ambiguous codex-chatgpt-web route markers");
  }
  const ownedRoute = routeMarkerCount === 1 || ownedHook;
  const removals = new Set<number>();

  const model = findTopLevelAssignment(document.lines, "model");
  if (options.removeWebModel !== false
    && model.index !== undefined
    && model.value?.startsWith("chatgpt-web/")) removals.add(model.index);

  const route = findTopLevelAssignment(document.lines, "openai_base_url");
  if (route.index !== undefined) {
    if (managedBridgeUrl(
      route.value,
      ownedRoute,
      options.removeBridgeWithoutEvidence !== false,
    )) removals.add(route.index);
    else if (routeMarkerCount > 0) conflicts.push("openai_base_url was changed after setup and was preserved");
  }

  const realtime = findTopLevelAssignment(document.lines, "experimental_realtime_webrtc_call_base_url");
  if (realtime.index !== undefined && ownedRoute) {
    if (realtime.value === CODEX_REALTIME_WEBRTC_CALL_BASE_URL) removals.add(realtime.index);
    else conflicts.push("experimental_realtime_webrtc_call_base_url was changed after setup and was preserved");
  }

  const exactManagedLines = new Set([
    MANAGED_REMOTE_COMPACTION_LINE,
    MANAGED_MULTI_AGENT_LINE,
    MANAGED_MULTI_AGENT_V2_LINE,
    MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  ]);
  document.lines.forEach((line, index) => {
    if (exactManagedLines.has(line)
      || /^max_depth = \d+ # Managed by codex-chatgpt-web: allows nested routed Web subagents in Compatibility V1\.$/.test(line)) {
      removals.add(index);
    }
  });
  [...removals].sort((left, right) => right - left).forEach(index => removeDocumentLine(document, index));
  removeManagedComment(document);
  return { text: renderDocument(document), conflicts };
}

function restorationWithJournal(
  current: string,
  journal: AnyCodexIntegrationJournal,
): { text: string; conflicts: string[] } {
  try {
    if (journal.version === 2) {
      if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
        throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
      }
      return { text: restoreLegacyV2(current, journal), conflicts: [] };
    }
    if ((journal.version === 4 || journal.version === 5 || journal.version === 6
      || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10)
      && !journal.active) {
      verifyRestoredRoute(current, journal);
      return { text: current, conflicts: [] };
    }
    return { text: restoreManagedRoute(current, journal), conflicts: [] };
  } catch (error) {
    if (journal.version === 2) throw error;
    let baseline: string;
    try {
      baseline = replacementBaseline(current, true, journal);
    } catch (replacementError) {
      if (journal.version !== 10
        || (!current.includes(MANAGED_INTERRUPT_HOOK_START) && !current.includes(MANAGED_INTERRUPT_HOOK_END))) {
        throw replacementError;
      }
      const withoutOrphan = restoreOrphanedCodexInterruptHook(current, journal.configPath);
      const journalWithoutHook: LegacyCodexIntegrationJournalV9 = {
        version: 9,
        active: journal.active,
        configPath: journal.configPath,
        installed: journal.installed,
        previous: journal.previous,
        previousRealtimeWebrtcCallBaseUrl: journal.previousRealtimeWebrtcCallBaseUrl,
        ...(journal.previousMultiAgent ? { previousMultiAgent: journal.previousMultiAgent } : {}),
        ...(journal.previousMultiAgentV2 ? { previousMultiAgentV2: journal.previousMultiAgentV2 } : {}),
        ...(journal.previousAgentMaxDepth ? { previousAgentMaxDepth: journal.previousAgentMaxDepth } : {}),
        ...(journal.format ? { format: journal.format } : {}),
      };
      baseline = replacementBaseline(withoutOrphan, true, journalWithoutHook);
    }
    const recovered = stripJournalIndependentManagedArtifacts(baseline, journal.configPath, {
      removeBridgeWithoutEvidence: false,
    });
    return {
      text: recovered.text,
      conflicts: [
        `The saved integration journal no longer matched the active config: ${error instanceof Error ? error.message : String(error)}`,
        ...recovered.conflicts,
      ],
    };
  }
}

function createNativeRestoreBackup(snapshots: ReturnType<typeof snapshotFile>[]): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const backupPath = join(getCodexHome(), "codex-web-gpt-backups", `${stamp}-${process.pid}`);
  mkdirSync(backupPath, { recursive: true });
  const names = new Map<string, string>([
    [getCodexConfigPath(), "config.toml"],
    [getCodexModelsCachePath(), "models_cache.json"],
    [getCodexJournalPath(), "integration-journal.json"],
    [getCodexJournalRecoveryPath(), "integration-journal.recovery.json"],
  ]);
  const writes = snapshots.flatMap(snapshot => snapshot.exists && snapshot.data
    ? [{ path: join(backupPath, names.get(snapshot.path) ?? basename(snapshot.path)), data: snapshot.data }]
    : []);
  if (writes.length > 0) writeFilesWithCompensation(writes);
  return backupPath;
}

/**
 * Restore official Codex routing without stopping the launcher runtime or deleting its data.
 * A valid journal restores the exact previous values. Missing or inconsistent journals fall back
 * to strict project markers, trusted hooks, loopback bridge URLs, and the chatgpt-web model namespace.
 */
export function restoreNativeCodexIntegration(): RestoreNativeCodexResult {
  const configPath = getCodexConfigPath();
  const paths = [
    configPath,
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ];
  const snapshots = paths.map(path => snapshotFile(path, { followSymlink: path === configPath }));
  const configSnapshot = snapshots[0]!;
  const current = configSnapshot.exists ? configSnapshot.data!.toString("utf8") : "";
  let journal: AnyCodexIntegrationJournal | undefined;
  let journalError: unknown;
  try {
    journal = readJournal();
  } catch (error) {
    journalError = error;
  }

  let restored = current;
  let conflicts: string[] = [];
  if (journal) {
    assertJournalTargetsConfig(journal, configPath);
    const result = restorationWithJournal(current, journal);
    const cleaned = stripJournalIndependentManagedArtifacts(result.text, configPath, {
      removeBridgeWithoutEvidence: false,
    });
    restored = cleaned.text;
    conflicts = [...result.conflicts, ...cleaned.conflicts];
  } else if (configSnapshot.exists) {
    const result = stripJournalIndependentManagedArtifacts(current, configPath);
    restored = result.text;
    conflicts = result.conflicts;
  }
  if (journalError) {
    conflicts.unshift(`The saved integration journal was invalid and was removed: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
  }

  const removals = [getCodexModelsCachePath(), getCodexJournalPath(), getCodexJournalRecoveryPath()];
  if (journal?.version === 2) removals.push(journal.catalogPath);
  const changed = restored !== current || removals.some(path => existsSync(path));
  if (!changed) return { changed: false, conflicts };

  const backupPath = createNativeRestoreBackup(snapshots);
  writeFilesWithCompensation(
    configSnapshot.exists ? [{ path: configPath, data: restored, followSymlink: true }] : [],
    removals,
  );
  return { changed: true, backupPath, conflicts };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7
    || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  const configSnapshot = snapshotFile(journal.configPath, { followSymlink: true });
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    writeFileSnapshot(configSnapshot, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [recoverySnapshot, journalSnapshot, modelsCacheSnapshot, catalogSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
        verifyRestoredRoute(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) {
        verifyInstalledRoute(text, journal);
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
