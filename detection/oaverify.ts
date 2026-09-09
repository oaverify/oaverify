import type { ToolRun } from "./reporting.ts";

interface OaverifyJsonReport {
  readonly findings?: readonly {
    readonly code?: string;
    readonly message?: string;
    readonly location?: string;
  }[];
}

function stderrMessage(stderr: string): string {
  return stderr.trim().slice(0, 400);
}

export function oaverifyCheckRun(
  status: number,
  parsed: OaverifyJsonReport | undefined,
  stderr: string,
): ToolRun {
  if (parsed?.findings !== undefined) {
    return {
      findings: parsed.findings.map((f) => ({
        rule: f.code ?? "",
        message: f.message ?? "",
        location: f.location ?? "",
        severity: "warn",
      })),
    };
  }
  if (status === 0) return { findings: [] };
  if (status === 2) {
    return {
      findings: [
        {
          rule: "exit-2",
          message: stderrMessage(stderr) || "oaverify check exited 2 without a JSON report",
          location: "",
          severity: "error",
        },
      ],
    };
  }
  return { findings: [], fatal: stderrMessage(stderr) };
}
