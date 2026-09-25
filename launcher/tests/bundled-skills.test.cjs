const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  listBundledSkills,
  syncBundledSkills,
  validateBundledSkillSelection,
} = require("../electron/bundled-skills.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bundled-skills-"));
  const sourceRoot = path.join(root, "source");
  const codexHome = path.join(root, "codex");
  for (const name of ["alpha-skill", "beta-skill"]) {
    const skill = path.join(sourceRoot, name);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), `# ${name}\n`);
    fs.writeFileSync(path.join(skill, ".managed-by-codex-web-gpt"), "test\n");
  }
  return { root, sourceRoot, codexHome };
}

test("lists and validates bundled skill choices deterministically", () => {
  const { root, sourceRoot } = fixture();
  try {
    const available = listBundledSkills(sourceRoot);
    assert.deepEqual(available, ["alpha-skill", "beta-skill"]);
    assert.deepEqual(validateBundledSkillSelection(["beta-skill", "beta-skill"], available), ["beta-skill"]);
    assert.throws(() => validateBundledSkillSelection(["unknown"], available), /Unknown bundled skill/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selection installs chosen managed skills and removes deselected managed skills", () => {
  const { root, sourceRoot, codexHome } = fixture();
  try {
    syncBundledSkills({ sourceRoot, codexHome, selectedSkills: ["alpha-skill", "beta-skill"] });
    const result = syncBundledSkills({ sourceRoot, codexHome, selectedSkills: ["beta-skill"] });
    assert.deepEqual(result.installed, ["beta-skill"]);
    assert.deepEqual(result.removed, ["alpha-skill"]);
    assert.equal(fs.existsSync(path.join(codexHome, "skills", "alpha-skill")), false);
    assert.equal(fs.readFileSync(path.join(codexHome, "skills", "beta-skill", "SKILL.md"), "utf8"), "# beta-skill\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deselection never removes a personal skill without the managed marker", () => {
  const { root, sourceRoot, codexHome } = fixture();
  try {
    const personal = path.join(codexHome, "skills", "alpha-skill");
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, "SKILL.md"), "personal\n");
    const result = syncBundledSkills({ sourceRoot, codexHome, selectedSkills: [] });
    assert.deepEqual(result.removed, []);
    assert.equal(fs.readFileSync(path.join(personal, "SKILL.md"), "utf8"), "personal\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
