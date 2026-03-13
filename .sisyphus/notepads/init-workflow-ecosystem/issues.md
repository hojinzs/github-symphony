# Issues — init-workflow-ecosystem

## Known Gotchas

- init.ts:176 currently only extracts option.name — must preserve full statusField object with IDs
- YAML special chars: "Won't Do", "In Progress (Blocked)" need double-quoting
- renderPrompt() strict mode: ONLY use the 8 supported variables
- resolveSkillsDir() must return null for custom runtime (not throw)
- writeConfig() in init.ts is shared with tenant.ts — do NOT add ecosystem logic there
