export interface PlainDataCloneLimits {
  maxArrayLength?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxRecordProperties?: number;
  maxStringLength?: number;
}

interface CloneState {
  limits: Required<PlainDataCloneLimits>;
  nodes: number;
  seen: Set<object>;
  stringLength: number;
}

const DEFAULT_LIMITS: Required<PlainDataCloneLimits> = {
  maxArrayLength: 10_000,
  maxDepth: 64,
  maxNodes: 50_000,
  maxRecordProperties: 2_000,
  maxStringLength: 2_000_000,
};

function cloneValue(value: unknown, state: CloneState, depth: number): unknown {
  if (typeof value === "string") {
    state.stringLength += value.length;
    if (state.stringLength > state.limits.maxStringLength) {
      throw new Error("Submitted strings exceed the clone limit");
    }
    return value;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (
    typeof value !== "object" ||
    state.seen.has(value) ||
    depth > state.limits.maxDepth
  ) {
    throw new Error("Unsafe submitted value");
  }

  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new Error("Submitted value exceeds the clone node limit");
  }
  state.seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (
      prototype !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("Unsafe submitted array");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      throw new Error("Unsafe submitted array length");
    }
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > state.limits.maxArrayLength
    ) {
      throw new Error("Unsafe submitted array length");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const allowedKeys = new Set(["length"]);
    const cloned: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      allowedKeys.add(key);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("Unsafe submitted array item");
      }
      cloned.push(cloneValue(descriptor.value, state, depth + 1));
    }
    if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
      throw new Error("Unsafe submitted array property");
    }
    state.seen.delete(value);
    return cloned;
  }

  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error("Unsafe submitted record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > state.limits.maxRecordProperties) {
    throw new Error("Submitted record exceeds the clone property limit");
  }
  const cloned = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      throw new Error("Unsafe submitted accessor");
    }
    cloned[key] = cloneValue(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return cloned;
}

/** Clone untrusted input without invoking accessors or accepting custom prototypes. */
export function clonePlainData(
  value: unknown,
  limits: PlainDataCloneLimits = {}
): unknown {
  return cloneValue(
    value,
    {
      limits: { ...DEFAULT_LIMITS, ...limits },
      nodes: 0,
      seen: new Set<object>(),
      stringLength: 0,
    },
    0
  );
}
