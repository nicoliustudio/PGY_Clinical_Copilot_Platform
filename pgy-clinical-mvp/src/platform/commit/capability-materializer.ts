/** Generic metadata-driven delivery materializer. 不包含任何模态名称分支。 */

export interface DeliveryObligationManifest {
  id: string;
  requiredFields?: readonly string[];
  requiredFieldsByOutcome?: Readonly<Record<string, readonly string[]>>;
}

export interface CapabilityManifest {
  id: string;
  provides: readonly string[];
  deliveryObligations: readonly DeliveryObligationManifest[];
}

function readPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function resolveUniqueProvider(
  manifests: readonly CapabilityManifest[],
  outcome: string,
): CapabilityManifest | undefined {
  const owners = manifests.filter((manifest) => manifest.provides.includes(outcome));
  return owners.length === 1 ? owners[0] : undefined;
}

export function missingRequiredFields(
  product: Readonly<Record<string, unknown>>,
  obligation: DeliveryObligationManifest,
  outcome: string,
): string[] {
  const fields = [...new Set([
    ...(obligation.requiredFields ?? []),
    ...(obligation.requiredFieldsByOutcome?.[outcome] ?? []),
  ])];
  return fields.filter((field) => !meaningful(readPath(product, field)));
}
