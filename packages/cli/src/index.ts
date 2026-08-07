export { buildProgram } from "./cli.js";
export {
  compileSchemaCommand,
  defaultCommandIo,
  resolveCommand,
  validateCommand,
  type CommandIo,
  type CommandOptions,
  type CommandResult,
  type ValidateMode,
} from "./commands.js";
export { type StandaloneDialect } from "./emit-standalone.js";
export { parseHttpFile } from "./http-parser.js";
export {
  confineRootFor,
  defaultPolicy,
  DEFAULT_REMOTE_REFS,
  entryRefusal,
  fileOptionsFor,
  httpOptionsFor,
  parseRemoteRefs,
  policyHttpReader,
  REMOTE_REFS_MODES,
  remoteRefsNotice,
  type ReaderPolicy,
  type RemoteRefsMode,
} from "./reader-policy.js";
