import type { ScoreBreakdown, Skill, Suggestions } from '@teamforge/shared';

export const scoring: Suggestions['scoring'] = {
  weights: { skill: 0.65, timezone: 0.35, needCoverage: 0.7, complement: 0.3 }, workdayHours: 8,
  explanation: "score = round(100 * (0.65 * skill + 0.35 * timezone)). skill = 0.7 * share of the team's needs covered + 0.3 * share of candidate skills new to the team; with no needs, skill is the new-skill share. timezone = shared working hours / 8.",
};
export function median(offsets: number[]) {
  const sorted = [...offsets].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function scoreCandidate(teamSkills: Skill[], needs: Skill[], reference: number, skills: Skill[], offset: number): ScoreBreakdown {
  const needCovered = skills.filter((s) => needs.includes(s)).sort();
  const newToTeam = skills.filter((s) => !teamSkills.includes(s)).sort();
  const redundant = skills.filter((s) => teamSkills.includes(s)).sort();
  const needCoverage = needs.length ? needCovered.length / needs.length : 0;
  const complementRatio = skills.length ? newToTeam.length / skills.length : 0;
  const skillScore = needs.length ? scoring.weights.needCoverage * needCoverage + scoring.weights.complement * complementRatio : complementRatio;
  const distance = Math.abs(offset - reference) % 1440;
  const deltaHours = Math.min(distance, 1440 - distance) / 60;
  const overlapHours = Math.max(0, scoring.workdayHours - deltaHours);
  const timezoneScore = overlapHours / scoring.workdayHours;
  return {
    skill: { needCovered, newToTeam, redundant, needCoverage, complementRatio, score: skillScore },
    timezone: { offsetMin: offset, teamReferenceOffsetMin: reference, deltaHours, overlapHours, score: timezoneScore },
    total: Math.round(100 * (scoring.weights.skill * skillScore + scoring.weights.timezone * timezoneScore)),
  };
}
