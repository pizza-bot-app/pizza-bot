/** Private parent/child messages used by the embedded desktop sidecar. */

export interface SidecarSecretUpdate {
  type: "secrets.update";
  requestId: number;
  values: Record<string, string | null>;
}

export interface SidecarSecretUpdateResult {
  type: "secrets.updated";
  requestId: number;
  ok: boolean;
}

export function isDesktopSecretName(name: string): boolean {
  return /^PIZZA_SECRET_[A-Za-z0-9_]+$/.test(name);
}

export function isSidecarSecretUpdate(value: unknown): value is SidecarSecretUpdate {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { type?: unknown }).type !== "secrets.update" ||
    !Number.isSafeInteger((value as { requestId?: unknown }).requestId)
  ) {
    return false;
  }
  const values = (value as { values?: unknown }).values;
  return Boolean(
    values &&
      typeof values === "object" &&
      !Array.isArray(values) &&
      Object.entries(values).every(
        ([name, secret]) =>
          isDesktopSecretName(name) && (typeof secret === "string" || secret === null),
      ),
  );
}

export function isSidecarSecretUpdateResult(
  value: unknown,
): value is SidecarSecretUpdateResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "secrets.updated" &&
      Number.isSafeInteger((value as { requestId?: unknown }).requestId) &&
      typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

export function applySidecarSecretUpdate(
  update: SidecarSecretUpdate,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [name, secret] of Object.entries(update.values)) {
    if (secret === null) delete env[name];
    else env[name] = secret;
  }
}
