export { generateGhSymphonySkill } from "./gh-symphony.js";
export { generateGhProjectSkill } from "./gh-project.js";
export { generateCommitSkill } from "./commit.js";
export { generatePushSkill } from "./push.js";
export { generatePullSkill } from "./pull.js";
export { generateLandSkill } from "./land.js";

import type { SkillTemplate } from "../types.js";
import { generateGhSymphonySkill } from "./gh-symphony.js";
import { generateGhProjectSkill } from "./gh-project.js";
import { generateCommitSkill } from "./commit.js";
import { generatePushSkill } from "./push.js";
import { generatePullSkill } from "./pull.js";
import { generateLandSkill } from "./land.js";
import { GH_SYMPHONY_REFERENCE_FILES } from "./gh-symphony-references/index.js";

export const ALL_SKILL_TEMPLATES: SkillTemplate[] = [
  {
    name: "gh-symphony",
    files: [
      { relativePath: "SKILL.md", generate: generateGhSymphonySkill },
      ...GH_SYMPHONY_REFERENCE_FILES,
    ],
  },
  {
    name: "gh-project",
    files: [{ relativePath: "SKILL.md", generate: generateGhProjectSkill }],
  },
  {
    name: "commit",
    files: [{ relativePath: "SKILL.md", generate: generateCommitSkill }],
  },
  {
    name: "push",
    files: [{ relativePath: "SKILL.md", generate: generatePushSkill }],
  },
  {
    name: "pull",
    files: [{ relativePath: "SKILL.md", generate: generatePullSkill }],
  },
  {
    name: "land",
    files: [{ relativePath: "SKILL.md", generate: generateLandSkill }],
  },
];
