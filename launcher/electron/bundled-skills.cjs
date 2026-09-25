const fs = require("node:fs");
const path = require("node:path");

const SKILL_NAME = /^[a-z0-9-]{1,63}$/;

function listBundledSkills(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) return [];
  return fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && SKILL_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

function validateBundledSkillSelection(value, available) {
  if (!Array.isArray(value)) throw new Error("Bundled skill selection must be an array");
  const allowed = new Set(available);
  const selected = [];
  for (const skill of value) {
    if (typeof skill !== "string" || !allowed.has(skill)) {
      throw new Error(`Unknown bundled skill: ${String(skill)}`);
    }
    if (!selected.includes(skill)) selected.push(skill);
  }
  return selected.sort();
}

function syncBundledSkills({ sourceRoot, codexHome, selectedSkills }) {
  const available = listBundledSkills(sourceRoot);
  const selected = validateBundledSkillSelection(selectedSkills, available);
  const selectedSet = new Set(selected);
  const skillsRoot = path.join(codexHome, "skills");
  const installed = [];
  const removed = [];
  const preserved = [];
  fs.mkdirSync(skillsRoot, { recursive: true });

  for (const skill of available) {
    const source = path.join(sourceRoot, skill);
    const destination = path.join(skillsRoot, skill);
    const marker = path.join(destination, ".managed-by-codex-web-gpt");
    if (selectedSet.has(skill)) {
      if (fs.existsSync(destination) && !fs.existsSync(marker)) {
        preserved.push(skill);
        continue;
      }
      fs.cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
      installed.push(skill);
      continue;
    }
    if (fs.existsSync(marker)) {
      fs.rmSync(destination, { recursive: true, force: true });
      removed.push(skill);
    }
  }

  return { available, selected, installed, removed, preserved };
}

module.exports = {
  listBundledSkills,
  syncBundledSkills,
  validateBundledSkillSelection,
};
