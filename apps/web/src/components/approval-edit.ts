export interface ApprovalEditState {
  changed: boolean;
  approveLabel: "Approve" | "Approve edited";
}

export function approvalEditState(original: string, draft: string): ApprovalEditState {
  const changed = draft !== original;
  return {
    changed,
    approveLabel: changed ? "Approve edited" : "Approve",
  };
}
