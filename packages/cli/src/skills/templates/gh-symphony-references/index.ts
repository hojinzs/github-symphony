import type { SkillFile } from "../../types.js";
import { generateGhSymphonyReferencesReadme } from "./readme.js";
import { generateWorkflowSchemaReference } from "./workflow-schema.js";
import { generateWorkflowPostureImplementReference } from "./workflow-posture-implement.js";
import { generateWorkflowPostureReviewReference } from "./workflow-posture-review.js";
import { generateWorkflowPostureMaintainReference } from "./workflow-posture-maintain.js";

export const GH_SYMPHONY_REFERENCE_FILES: SkillFile[] = [
  {
    relativePath: "references/README.md",
    generate: generateGhSymphonyReferencesReadme,
  },
  {
    relativePath: "references/workflow-schema.md",
    generate: generateWorkflowSchemaReference,
  },
  {
    relativePath: "references/workflow-posture-implement.md",
    generate: generateWorkflowPostureImplementReference,
  },
  {
    relativePath: "references/workflow-posture-review.md",
    generate: generateWorkflowPostureReviewReference,
  },
  {
    relativePath: "references/workflow-posture-maintain.md",
    generate: generateWorkflowPostureMaintainReference,
  },
];
