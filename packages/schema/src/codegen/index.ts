export {
  booleanLiteral,
  checkStringArray,
  CodeGen,
  nonNegativeIntegerLiteral,
  numberLiteral,
  pathJoinExpr,
  positiveNumberLiteral,
  quoteString,
  rawExpr,
  stringArrayValue,
} from "./codegen.js";
export type { CodeEmitter, NameGenerator, PathSegmentLike, RawExpression } from "./codegen.js";
export { NAMES } from "./names.js";
export { Scope } from "./scope.js";
