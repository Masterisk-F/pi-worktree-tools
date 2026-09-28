// ---------------------------------------------------------------------------
// validateBranchName — validate a proposed git branch name
// ---------------------------------------------------------------------------

/* eslint-disable-next-line no-control-regex */
const BRANCH_NAME_RE = /(\.\.|~|\^|:|\\|[\x00-\x1f\x7f]|\s)|\.lock$/;

export function validateBranchName(name: string): string | null {
  if (!name || name.length === 0) {
    return "Branch name cannot be empty";
  }
  if (name.startsWith("-")) {
    return "Branch name cannot start with '-'";
  }
  if (name.toUpperCase() === "HEAD") {
    return "Branch name cannot be 'HEAD'";
  }
  const match = BRANCH_NAME_RE.exec(name);
  if (match) {
    return `Branch name contains invalid character: '${match[1] || name.slice(-5)}'`;
  }
  return null;
}
