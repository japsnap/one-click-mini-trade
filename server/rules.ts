/**
 * Load the rule override file, check it and make it the active rule set (src/rules/rules.ts).
 *
 * Which file: the env var SETS_RULES_FILE when set (it must then exist), else
 * rules/my-rules.json when it exists (gitignored: each owner keeps his own), else none and
 * the defaults of src/rules/defaultRules.ts apply. A bad file stops the start with the key's name.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeRules, RulesError, setActiveRules, type SetRules } from "../src/rules/rules";

export interface LoadedRules {
  rules: SetRules;
  /** The file the override came from, or "defaults (src/rules/defaultRules.ts)". */
  source: string;
}

export function loadRulesFile(env: Record<string, string | undefined>, root: string): LoadedRules {
  const named = env.SETS_RULES_FILE?.trim();
  const file = named ? path.resolve(root, named) : path.join(root, "rules", "my-rules.json");
  if (!existsSync(file)) {
    if (named) throw new RulesError(`SETS_RULES_FILE points to ${file}, which does not exist`);
    setActiveRules();
    return { rules: mergeRules({}), source: "defaults (src/rules/defaultRules.ts)" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RulesError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  let rules: SetRules;
  try {
    rules = mergeRules(parsed);
  } catch (e) {
    throw new RulesError(`${file}: ${(e as Error).message}`);
  }
  setActiveRules(rules);
  return { rules, source: file };
}
