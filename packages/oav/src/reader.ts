/**
 * The reader chain the `oaverify` binary actually runs.
 *
 * Extracted from `cli.ts` so it can be tested. The chain in `cli.ts` was
 * built inline at module load, which meant nothing exercised it: the CLI
 * package's tests cover `defaultCommandIo`, and this chain shadows that
 * one for every http(s) URI, so a posture that held in those tests could
 * still do nothing in the shipped binary.
 */
import { composeReaders, type DocumentReader } from "@oaverify/internal-spec";
import {
  confineRootFor,
  fileOptionsFor,
  httpOptionsFor,
  policyHttpReader,
  type ReaderPolicy,
} from "@oaverify/internal-cli";
import { createSmartHttpReader, createYamlFileReader, createYamlStdinReader } from "@oaverify/yaml";

/**
 * Compose the YAML-aware readers in front of the JSON-only chain the
 * CLI package builds, applying `policy` to both.
 *
 * Order matters twice. The stdin reader goes first because
 * `createFileReader` claims every non-HTTP, non-memory URI and would
 * otherwise take `-` and look for a file of that name. The YAML file
 * reader shadows the JSON-only one so a piped or on-disk spec may be
 * either format, and `createSmartHttpReader` shadows the JSON-only HTTP
 * reader for the same reason, inspecting `Content-Type` to decide.
 *
 * That last one is why the posture is applied here as well as in
 * `defaultCommandIo`: this reader answers every http(s) URI, so it is
 * the one a remote `$ref` reaches.
 *
 * @param base - The reader `defaultCommandIo` built for the same policy.
 */
export function createCliReader(base: DocumentReader, policy: ReaderPolicy): DocumentReader {
  return composeReaders([
    createYamlStdinReader(),
    createYamlFileReader(confineRootFor(policy), fileOptionsFor(policy)),
    policyHttpReader(createSmartHttpReader(httpOptionsFor(policy)), policy),
    base,
  ]);
}
