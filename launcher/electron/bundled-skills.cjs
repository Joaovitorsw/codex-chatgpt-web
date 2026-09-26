const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

function copyDirectoryContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourceEntry, destinationEntry);
    } else if (entry.isFile()) {
      fs.writeFileSync(destinationEntry, fs.readFileSync(sourceEntry));
    }
  }
}

function replaceManagedSkill(source, destination, skillsRoot) {
  const temporary = path.join(skillsRoot, `.codex-web-gpt-${randomUUID()}.tmp`);
  try {
    copyDirectoryContents(source, temporary);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
      replaceManagedSkill(source, destination, skillsRoot);
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
