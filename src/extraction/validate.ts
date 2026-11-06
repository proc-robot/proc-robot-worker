import type { ListItem, ValidationFlag } from "./types.js";

/*
 * The validation engine (TASKS.md T1.3.8, D5): deterministic checks the
 * reviewer sees as flags. Messages are shown to the organization's members.
 */

/** Below this, a value is highlighted for review (D4). */
export const CONFIDENCE_THRESHOLD = 0.8;

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  specs: "specifications",
  quantity: "quantity",
  unit: "unit",
};

const key = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type Unchecked = Omit<ListItem, "validation_flags">;

function compare(item: Unchecked, earlier: Unchecked): ValidationFlag | null {
  const number = earlier.position + 1;
  for (const [name, value] of Object.entries(item.specs)) {
    const other = earlier.specs[name];
    if (other !== undefined && key(other) !== key(value)) {
      return {
        code: "conflicting_specs",
        field: "specs",
        message: `Same name as item ${number}, but ${name.replace(/_/g, " ")} differs (${other} vs ${value}).`,
      };
    }
  }
  if (Object.keys(item.specs).length !== Object.keys(earlier.specs).length) return null;
  if (item.unit_code !== earlier.unit_code) return null;
  if (item.quantity !== earlier.quantity) {
    return {
      code: "duplicate",
      message: `Same as item ${number} with a different quantity (${earlier.quantity ?? "none"} vs ${item.quantity ?? "none"}).`,
    };
  }
  return { code: "duplicate", message: `Same as item ${number}.` };
}

export function validateItems(items: Unchecked[]): ListItem[] {
  const seen = new Map<string, Unchecked[]>();
  return items.map((item) => {
    const flags: ValidationFlag[] = [];

    if (item.quantity === null) {
      flags.push({ code: "missing_quantity", field: "quantity", message: "No quantity." });
    }
    if (!item.unit) {
      flags.push({ code: "missing_unit", field: "unit", message: "No unit." });
    } else if (!item.unit_code) {
      flags.push({
        code: "unknown_unit",
        field: "unit",
        message: `"${item.unit}" isn't a known unit. Choose one from the list.`,
      });
    }

    const name = key(item.name);
    for (const earlier of seen.get(name) ?? []) {
      const flag = compare(item, earlier);
      if (flag) {
        flags.push(flag);
        break;
      }
    }
    seen.set(name, [...(seen.get(name) ?? []), item]);

    // A field already flagged as missing or unknown needs no second warning.
    const flagged = new Set(flags.map((flag) => flag.field));
    const uncertain = Object.entries(item.confidence.fields)
      .filter(
        ([field, value]) =>
          field in FIELD_LABELS && value < CONFIDENCE_THRESHOLD && !flagged.has(field),
      )
      .map(([field]) => field);
    if (uncertain.length > 0) {
      for (const field of uncertain) {
        flags.push({
          code: "low_confidence",
          field,
          message: `Check the ${FIELD_LABELS[field]}: the reading is uncertain.`,
        });
      }
    } else if (item.confidence.overall < CONFIDENCE_THRESHOLD) {
      flags.push({ code: "low_confidence", message: "Check this item: the reading is uncertain." });
    }

    return { ...item, validation_flags: flags };
  });
}
