export interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  path: string;
  content: string;
}

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  matchedTerms: string[];
}
