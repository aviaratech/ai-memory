import { normalizeRequiredText } from './normalization.js';
import { UNSAFE_JSON_POINTER_KEYS } from './runtime.js';
import { isArrayIndexToken, isContainerValue, isRecord } from './type-guards.js';

interface ApplyArrayPatchOperationInput {
  fieldName: string;
  operation: ParsedPatchOperation;
  token: string;
}
type JsonArray = unknown[];
type JsonContainer = JsonArray | JsonObject;
type JsonObject = Record<string, unknown>;
type OutOfRangeBehavior = 'error' | 'no-op';

interface ParseArrayIndexInput {
  allowAppend: boolean;
  allowEnd: boolean;
  arrayLength: number;
  fieldName: string;
  onOutOfRange: OutOfRangeBehavior;
  path: string;
}

interface ParsedPatchOperation {
  hasValue: boolean;
  op: PatchOperationType;
  path: string;
  value: unknown;
}

type PatchOperationType = 'add' | 'remove' | 'set';

interface ResolveContainerStepInput {
  createMissingContainers: boolean;
  nextToken: string;
  path: string;
  token: string;
}

interface ResolvePatchContainerInput {
  createMissingContainers: boolean;
  path: string;
  tokens: string[];
}

interface ResolvePatchContainerMissingParent {
  missingParent: true;
}

type ResolvePatchContainerResult = ResolvePatchContainerMissingParent | ResolvePatchContainerSuccess;

interface ResolvePatchContainerSuccess {
  container: JsonContainer;
  missingParent: false;
  token: string;
}

interface ResolveStepMissingParent {
  missingParent: true;
}

type ResolveStepResult = ResolveStepMissingParent | ResolveStepSuccess;
interface ResolveStepSuccess {
  missingParent: false;
  nextValue: JsonContainer;
}

const PATCH_OP_ADD: PatchOperationType = 'add';
const PATCH_OP_REMOVE: PatchOperationType = 'remove';
const PATCH_OP_SET: PatchOperationType = 'set';

export function applySnapshotPatch(baseSnapshot: unknown, input: { fieldName?: string; patch: unknown }): JsonObject {
  const fieldName = input.fieldName ?? 'snapshot.ops';
  const patch = input.patch;
  if (!isRecord(patch) || !Array.isArray(patch.ops)) {
    throw new Error(`${fieldName} must be an object with an ops array.`);
  }

  const baseValue: JsonObject = isRecord(baseSnapshot) ? baseSnapshot : {};
  const target = cloneJson(baseValue);

  for (const [index, operation] of patch.ops.entries()) {
    applySnapshotPatchOperation(target, {
      fieldName: `${fieldName}[${String(index)}]`,
      operation,
    });
  }

  return target;
}

export function cloneJson<T>(value: T): T {
  if (typeof value === 'undefined') {
    return value;
  }

  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

function applyArrayPatchOperation(container: JsonArray, input: ApplyArrayPatchOperationInput): void {
  const { fieldName, operation, token } = input;
  if (operation.op === PATCH_OP_REMOVE) {
    const index = parseArrayIndexToken(token, {
      allowAppend: false,
      allowEnd: false,
      arrayLength: container.length,
      fieldName: `${fieldName}.path`,
      onOutOfRange: 'no-op',
      path: operation.path,
    });
    if (index === undefined) {
      return;
    }

    container.splice(index, 1);
    return;
  }

  if (!operation.hasValue) {
    throw new Error(`${fieldName}.value is required for ${operation.op}.`);
  }

  const value = cloneJson(operation.value);
  if (operation.op === PATCH_OP_ADD) {
    const index = parseArrayIndexToken(token, {
      allowAppend: true,
      allowEnd: true,
      arrayLength: container.length,
      fieldName: `${fieldName}.path`,
      onOutOfRange: 'error',
      path: operation.path,
    });
    if (index === undefined) {
      throw new Error(`${fieldName}.path points outside array bounds in path ${operation.path}.`);
    }

    if (index === container.length) {
      container.push(value);
    } else {
      container.splice(index, 0, value);
    }
    return;
  }

  const index = parseArrayIndexToken(token, {
    allowAppend: false,
    allowEnd: true,
    arrayLength: container.length,
    fieldName: `${fieldName}.path`,
    onOutOfRange: 'error',
    path: operation.path,
  });
  if (index === undefined) {
    throw new Error(`${fieldName}.path points outside array bounds in path ${operation.path}.`);
  }

  if (index === container.length) {
    container.push(value);
  } else {
    container[index] = value;
  }
}

function applySnapshotPatchOperation(target: JsonContainer, input: { fieldName: string; operation: unknown }): void {
  const { fieldName, operation } = input;
  const parsedOperation = parsePatchOperation(operation, fieldName);
  const tokens = parseJsonPointerTokens(parsedOperation.path, `${fieldName}.path`);
  const resolved = resolvePatchContainer(target, {
    createMissingContainers: parsedOperation.op !== PATCH_OP_REMOVE,
    path: parsedOperation.path,
    tokens,
  });
  if (resolved.missingParent) {
    return;
  }

  const { container, token } = resolved;
  if (Array.isArray(container)) {
    applyArrayPatchOperation(container, {
      fieldName,
      operation: parsedOperation,
      token,
    });
    return;
  }

  assertSafeJsonPointerToken(token, parsedOperation.path);
  if (parsedOperation.op === PATCH_OP_REMOVE) {
    Reflect.deleteProperty(container, token);
    return;
  }

  if (!parsedOperation.hasValue) {
    throw new Error(`${fieldName}.value is required for ${parsedOperation.op}.`);
  }

  container[token] = cloneJson(parsedOperation.value);
}

function assertSafeJsonPointerToken(token: string, path: string): void {
  if (UNSAFE_JSON_POINTER_KEYS.has(token)) {
    throw new Error(`Patch path ${path} uses a protected object token.`);
  }
}

function decodeJsonPointerToken(token: string, fieldName: string): string {
  let index = 0;
  while (index < token.length) {
    if (token[index] !== '~') {
      index += 1;
      continue;
    }

    const marker = token[index + 1];
    if (marker !== '0' && marker !== '1') {
      throw new Error(`${fieldName} contains an invalid RFC 6901 escape sequence.`);
    }

    index += 2;
  }

  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parseArrayIndexToken(token: string, input: ParseArrayIndexInput): number | undefined {
  if (token === '-') {
    if (input.allowAppend) {
      return input.arrayLength;
    }

    if (input.onOutOfRange === 'no-op') {
      return undefined;
    }

    throw new Error(`${input.fieldName} cannot use "-" in path ${input.path}.`);
  }

  if (!isArrayIndexToken(token)) {
    if (input.onOutOfRange === 'no-op') {
      return undefined;
    }

    throw new Error(`${input.fieldName} must use numeric array indexes in path ${input.path}.`);
  }

  const index = Number(token);
  const maxAllowed = input.allowEnd ? input.arrayLength : input.arrayLength - 1;
  if (index > maxAllowed) {
    if (input.onOutOfRange === 'no-op') {
      return undefined;
    }

    throw new Error(`${input.fieldName} points outside array bounds in path ${input.path}.`);
  }

  return index;
}

function parseJsonPointerTokens(path: string, fieldName: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`${fieldName} must be an RFC 6901 JSON Pointer path.`);
  }

  return path
    .slice(1)
    .split('/')
    .map((token, tokenIndex) => {
      return decodeJsonPointerToken(token, `${fieldName}[${String(tokenIndex)}]`);
    });
}

function parsePatchOperation(operation: unknown, fieldName: string): ParsedPatchOperation {
  if (!isRecord(operation)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  const op = normalizeRequiredText(operation.op, `${fieldName}.op`);
  if (op !== PATCH_OP_ADD && op !== PATCH_OP_REMOVE && op !== PATCH_OP_SET) {
    throw new Error(`${fieldName}.op must be one of: add, set, remove.`);
  }

  return {
    hasValue: Object.hasOwn(operation, 'value'),
    op,
    path: normalizeRequiredText(operation.path, `${fieldName}.path`),
    value: operation.value,
  };
}

function resolveArrayContainerStep(container: JsonArray, input: ResolveContainerStepInput): ResolveStepResult {
  const tokenIndex = parseArrayIndexToken(input.token, {
    allowAppend: false,
    allowEnd: false,
    arrayLength: container.length,
    fieldName: 'path',
    onOutOfRange: input.createMissingContainers ? 'error' : 'no-op',
    path: input.path,
  });
  if (tokenIndex === undefined) {
    return { missingParent: true };
  }

  let nextValue = container[tokenIndex];
  if (!isContainerValue(nextValue)) {
    if (!input.createMissingContainers) {
      return { missingParent: true };
    }

    nextValue = shouldCreateArrayFromPointerToken(input.nextToken) ? [] : {};
    container[tokenIndex] = nextValue;
  }
  if (!isContainerValue(nextValue)) {
    throw new Error(`Patch path ${input.path} traverses a non-container value.`);
  }

  return {
    missingParent: false,
    nextValue,
  };
}

function resolveObjectContainerStep(container: JsonObject, input: ResolveContainerStepInput): ResolveStepResult {
  assertSafeJsonPointerToken(input.token, input.path);
  let nextValue = container[input.token];
  if (!isContainerValue(nextValue)) {
    if (!input.createMissingContainers) {
      return { missingParent: true };
    }

    nextValue = shouldCreateArrayFromPointerToken(input.nextToken) ? [] : {};
    container[input.token] = nextValue;
  }
  if (!isContainerValue(nextValue)) {
    throw new Error(`Patch path ${input.path} traverses a non-container value.`);
  }

  return {
    missingParent: false,
    nextValue,
  };
}

function resolvePatchContainer(
  rootValue: JsonContainer,
  input: ResolvePatchContainerInput,
): ResolvePatchContainerResult {
  const { tokens } = input;
  if (tokens.length === 0) {
    throw new Error('Patch operation path must reference at least one token.');
  }

  let container: JsonContainer = rootValue;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    // Loop bounds guarantee index and index + 1 are within array range.
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (token === undefined || nextToken === undefined) {
      break;
    }

    if (Array.isArray(container)) {
      const resolved = resolveArrayContainerStep(container, {
        createMissingContainers: input.createMissingContainers,
        nextToken,
        path: input.path,
        token,
      });
      if (resolved.missingParent) {
        return { missingParent: true };
      }
      container = resolved.nextValue;
      continue;
    }

    const resolved = resolveObjectContainerStep(container, {
      createMissingContainers: input.createMissingContainers,
      nextToken,
      path: input.path,
      token,
    });
    if (resolved.missingParent) {
      return { missingParent: true };
    }
    container = resolved.nextValue;
  }

  // Guard at top ensures tokens.length >= 1
  const terminalToken = tokens[tokens.length - 1];
  if (terminalToken === undefined) {
    throw new Error('Patch operation path must reference at least one token.');
  }

  return {
    container,
    missingParent: false,
    token: terminalToken,
  };
}

function shouldCreateArrayFromPointerToken(token: string) {
  return token === '-' || isArrayIndexToken(token);
}
