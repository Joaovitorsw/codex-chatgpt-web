import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CODEX_SKILLS, installBundledCodexSkills } from "../src/codex-skills";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("installs every bundled skill without removing personal skills", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-skills-"));
  roots.push(root);
  const personal = join(root, "codex", "skills", "personal", "SKILL.md");
  mkdirSync(join(root, "codex", "skills", "personal"), { recursive: true });
  writeFileSync(personal, "personal skill\n");

  const result = installBundledCodexSkills({
    codexHome: join(root, "codex"),
    sourceRoot: join(import.meta.dir, "..", "launcher", "assets", "skills"),
  });

  expect(result.skills).toEqual([...BUNDLED_CODEX_SKILLS]);
  expect(existsSync(personal)).toBe(true);
  expect(readFileSync(personal, "utf8")).toBe("personal skill\n");
  expect(existsSync(join(root, "codex", "skills", "chatgpt-image-handoff", "scripts", "generate-image.ps1"))).toBe(true);
  expect(readFileSync(join(root, "codex", "skills", "chatgpt-image-handoff", "SKILL.md"), "utf8"))
    .toContain("without requiring the user to name this skill");
  expect(existsSync(join(root, "codex", "skills", "code-task-presentation", "agents", "openai.yaml"))).toBe(true);
  expect(existsSync(join(root, "codex", "skills", "frontend-visual-qa", "agents", "openai.yaml"))).toBe(true);
  expect(readFileSync(join(root, "codex", "skills", "frontend-visual-qa", "SKILL.md"), "utf8"))
    .toBe(readFileSync(join(import.meta.dir, "..", "launcher", "assets", "skills", "frontend-visual-qa", "SKILL.md"), "utf8"));
  expect(existsSync(join(root, "codex", "skills", "code-work-orchestrator", "references", "diagnosis.md"))).toBe(true);
  expect(existsSync(join(root, "codex", "skills", "code-work-orchestrator", "references", "implementation.md"))).toBe(true);
  expect(existsSync(join(root, "codex", "skills", "code-work-orchestrator", "references", "frontend.md"))).toBe(true);
  expect(existsSync(join(root, "codex", "skills", "code-work-orchestrator", "references", "validation.md"))).toBe(true);
  expect(readFileSync(join(root, "codex", "skills", "code-task-presentation", ".managed-by-codex-web-gpt"), "utf8").trim()).toBe("6.0.8");
});

test("reinstall updates managed files and preserves extra user files", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-skills-"));
  roots.push(root);
  const skill = join(root, "codex", "skills", "code-task-presentation");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "outdated\n");
  writeFileSync(join(skill, "notes.txt"), "keep me\n");

  installBundledCodexSkills({
    codexHome: join(root, "codex"),
    sourceRoot: join(import.meta.dir, "..", "launcher", "assets", "skills"),
  });

  expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("# Code Task Presentation");
  expect(readFileSync(join(skill, "notes.txt"), "utf8")).toBe("keep me\n");
});
