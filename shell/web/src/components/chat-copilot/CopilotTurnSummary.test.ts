import { fileBaseName, sameFsPath } from "../shared/pathUtils";
import { splitSummaryWithPaths } from "./CopilotTurnSummary";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const windows = String.raw`结论如下。相关文件路径：
C:\Users\Administrator\.dataagent\anonymous\abc\subagent_output\nl2sql\0\query.sql
C:\Users\Administrator\.dataagent\anonymous\abc\subagent_output\nl2sql\0\result.csv`;

const parts = splitSummaryWithPaths(windows);
const paths = parts.filter((part) => part.type === "path").map((part) => part.value);
assert(paths.length === 2, `expected 2 paths, got ${paths.length}`);
assert(fileBaseName(paths[0]) === "query.sql", paths[0]);
assert(fileBaseName(paths[1]) === "result.csv", paths[1]);
assert(
  sameFsPath(paths[0], paths[0].replace(/\\/g, "/")),
  "slash direction should not matter",
);

const posix = splitSummaryWithPaths("图表：~/dataagent/work/plot.png 已生成");
assert(posix.some((part) => part.type === "path" && part.value.endsWith("plot.png")), "posix path");

console.log("CopilotTurnSummary path assertions passed");
