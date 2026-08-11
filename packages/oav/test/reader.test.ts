import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCommandIo, policyFor, type ReaderPolicy } from "@oaverify/internal-cli";
import { createCliReader } from "../src/reader.js";

/**
 * The chain the shipped binary runs. Its point is that
 * `createSmartHttpReader` shadows the JSON-only HTTP reader inside
 * `defaultCommandIo` for every http(s) URI, so this is the reader a
 * remote `$ref` actually reaches. A posture enforced only in the CLI
 * package would pass its own tests and do nothing here.
 */
function cliReader(policy: ReaderPolicy) {
  return createCliReader(defaultCommandIo().reader(policy), policy);
}

const REMOTE_ENTRY = "https://api.example.com/openapi.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createCliReader", () => {
  it("refuses a remote ref from a local entry under the default posture", async () => {
    // v7 flipped this default to same-origin (#692). A local entry
    // opted into no origin, so this never reaches the network.
    const fetchMock = stubFetch();
    await expect(
      cliReader(policyFor("./spec.yaml")).read("https://api.example.com/pet.json"),
    ).rejects.toThrow(/refused by --remote-refs same-origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches it when the caller asks for allow", async () => {
    const fetchMock = stubFetch();
    await cliReader(policyFor("./spec.yaml", { remoteRefs: "allow" })).read(
      "https://api.example.com/pet.json",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a remote ref under deny, without reaching the network", async () => {
    const fetchMock = stubFetch();
    await expect(
      cliReader(policyFor("./spec.yaml", { remoteRefs: "deny" })).read(
        "https://internal.corp/x.json",
      ),
    ).rejects.toThrow(/refused by --remote-refs deny/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits the entry's origin and refuses another under same-origin", async () => {
    const fetchMock = stubFetch();
    const policy = policyFor(REMOTE_ENTRY, { remoteRefs: "same-origin" });
    await cliReader(policy).read("https://api.example.com/schemas/pet.json");
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(
      cliReader(policy).read("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/refused by --remote-refs same-origin/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses everything remote under same-origin when the entry is local", async () => {
    const fetchMock = stubFetch();
    await expect(
      cliReader(policyFor("./spec.yaml", { remoteRefs: "same-origin" })).read(
        "https://api.example.com/pet.json",
      ),
    ).rejects.toThrow(/the entry is not remote/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the posture implied by --untrusted", async () => {
    // The regression this file exists for: --untrusted implies
    // same-origin, and the implication has to survive the composition.
    const fetchMock = stubFetch();
    await expect(
      cliReader(policyFor("./spec.yaml", { untrusted: true })).read(
        "https://api.example.com/pet.json",
      ),
    ).rejects.toThrow(/refused by --remote-refs same-origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets an explicit --remote-refs allow override --untrusted", async () => {
    const fetchMock = stubFetch();
    await cliReader(policyFor("./spec.yaml", { untrusted: true, remoteRefs: "allow" })).read(
      "https://api.example.com/pet.json",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("puts a timeout on every request, from the caps", async () => {
    const fetchMock = stubFetch();
    await cliReader(policyFor("./spec.yaml", { remoteRefs: "allow" })).read(
      "https://api.example.com/pet.json",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/pet.json",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
