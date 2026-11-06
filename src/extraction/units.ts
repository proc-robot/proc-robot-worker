import type { Unit } from "./types.js";

/*
 * Unit normalization (TASKS.md T1.3.9, D7): "Unit", "bh", "Mtr." and "m²"
 * map to the `units` table's codes (pcs, m, m2) through their aliases.
 */

export const unitKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim();

export type UnitIndex = Map<string, string>;

export function buildUnitIndex(units: Unit[]): UnitIndex {
  const index: UnitIndex = new Map();
  for (const unit of units) {
    for (const name of [unit.code, unit.name, ...unit.aliases]) {
      const key = unitKey(name);
      if (key && !index.has(key)) index.set(key, unit.code);
    }
  }
  return index;
}

/** The unit's code, or null when the unit is unknown (it is then flagged for review). */
export function normalizeUnit(unit: string | null, index: UnitIndex): string | null {
  if (!unit) return null;
  const key = unitKey(unit);
  return index.get(key) ?? index.get(key.replace(/s$/, "")) ?? null;
}
