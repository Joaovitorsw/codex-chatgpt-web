import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getCodexHome } from "./codex-integration-shared";

export const BUNDLED_CODEX_SKILLS = [
  "chatgpt-image-handoff",
  "code-work-orchestrator",
  "code-task-presentation",
  "frontend-visual-qa",
] as const;

export interface InstallBundledCodexSkillsOptions {
  codexHome?: string;
  sourceRoot?: string;
}

export interface InstallBundledCodexSkillsResult {
  skills: string[];
  files: string[];
}

function defaultSourceRoot(): string {
  const candidates = [
    join(import.meta.dir, "skills"),
    join(import.meta.dir, "..", "launcher", "assets", "skills"),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error("Bundled Codex skills are missing from this installation");
  return found;
}

function skillFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Bundled skill contains an unsupported symbolic link: ${absolute}`);
    }
    if (entry.isDirectory()) files.push(...skillFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
  return files.sort();
}

function installFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.codex-web-gpt-${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function installBundledCodexSkills(
  options: InstallBundledCodexSkillsOptions = {},
): InstallBundledCodexSkillsResult {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot());
  const targetRoot = join(resolve(options.codexHome ?? getCodexHome()), "skills");
  const installedFiles: string[] = [];

  for (const skill of BUNDLED_CODEX_SKILLS) {
    const sourceSkill = join(sourceRoot, skill);
    if (!existsSync(join(sourceSkill, "SKILL.md"))) {
      throw new Error(`Bundled Codex skill is incomplete: ${skill}/SKILL.md`);
    }
    for (const file of skillFiles(sourceSkill)) {
      const normalized = file.split(sep).join("/");
      const destination = join(targetRoot, skill, file);
      installFile(join(sourceSkill, file), destination);
      installedFiles.push(`${skill}/${normalized}`);
    }
  }

  return { skills: [...BUNDLED_CODEX_SKILLS], files: installedFiles };
}
