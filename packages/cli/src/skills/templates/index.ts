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

export const ALL_SKILL_TEMPLATES: SkillTemplate[] = [
  {
    name: "gh-symphony",
    fileName: "SKILL.md",
    generate: generateGhSymphonySkill,
  },
  {
    name: "gh-project",
    fileName: "SKILL.md",
    generate: generateGhProjectSkill,
  },
  { name: "commit", fileName: "SKILL.md", generate: generateCommitSkill },
  { name: "push", fileName: "SKILL.md", generate: generatePushSkill },
  { name: "pull", fileName: "SKILL.md", generate: generatePullSkill },
  { name: "land", fileName: "SKILL.md", generate: generateLandSkill },
];
