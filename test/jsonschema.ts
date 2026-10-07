// A small JSON Schema checker for the tests: the keywords schema/ uses, no more.
type Schema = Record<string, any> | boolean;

export function check(schema: Schema, value: unknown, refs: Record<string, Schema> = {}, root: Schema = schema, path = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  const s = schema as Record<string, any>;
  const errs: string[] = [];
  const sub = (sch: Schema, v: unknown, p: string, r: Schema = root) => check(sch, v, refs, r, p);
  if (s.$ref) {
    const ref = s.$ref as string;
    if (ref.startsWith("#/$defs/")) errs.push(...sub((root as any).$defs[ref.slice(8)], value, path));
    else errs.push(...sub(refs[ref], value, path, refs[ref]));
  }
  const type = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = type(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [...errs, `${path}: expected ${types.join("|")}, got ${t}`];
  }
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) errs.push(`${path}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((x: unknown) => JSON.stringify(x) === JSON.stringify(value))) errs.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if (typeof value === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(value)) errs.push(`${path}: does not match ${s.pattern}`);
    if (s.minLength !== undefined && value.length < s.minLength) errs.push(`${path}: too short`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => errs.push(...sub(s.items, v, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(o)) {
      if (s.properties?.[k] !== undefined) errs.push(...sub(s.properties[k], v, `${path}.${k}`));
      else if (s.additionalProperties !== undefined) errs.push(...sub(s.additionalProperties, v, `${path}.${k}`));
    }
  }
  if (s.anyOf && !s.anyOf.some((x: Schema) => !sub(x, value, path).length)) errs.push(`${path}: matches none of anyOf`);
  if (s.oneOf && s.oneOf.filter((x: Schema) => !sub(x, value, path).length).length !== 1) errs.push(`${path}: matches not exactly one of oneOf`);
  for (const x of s.allOf ?? []) {
    if (x.if && !sub(x.if, value, path).length) errs.push(...sub(x.then ?? true, value, path));
    else if (!x.if) errs.push(...sub(x, value, path));
  }
  return errs;
}
