'use strict';

// Subsequence match, scored so contiguous and early hits rank first.
function fuzzyScore(text, query) {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let last = -1;
  for (const char of needle) {
    const index = hay.indexOf(char, last + 1);
    if (index < 0) return null;
    score += index === last + 1 ? 3 : 1;
    if (index === 0) score += 2;
    last = index;
  }
  return score;
}

function filterProjects(projects, query) {
  if (!query) return projects;
  return projects
    .map((project) => ({ project, score: fuzzyScore(project.name, query) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .map((entry) => entry.project);
}

module.exports = { fuzzyScore, filterProjects };
