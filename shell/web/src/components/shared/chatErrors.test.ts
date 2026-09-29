import { humanizeChatError, isCancelMessage } from "./chatErrors";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(humanizeChatError("", true) === "已取消当前请求", "abort");
assert(humanizeChatError("Failed to fetch").includes("8788"), "fetch");
assert(humanizeChatError("Chat failed: 500").includes("后端处理失败"), "http 500");
assert(humanizeChatError("错误：未收到最终结果").includes("没有收到最终结论"), "strip prefix");
assert(humanizeChatError("Session workspace is busy: /tmp/ws").includes("工作区正被占用"), "workspace busy");
assert(
  humanizeChatError("Blocked by SQL security rules: SQL-001 INSERT INTO t VALUES (1)").includes("敏感数据或违反安全规则"),
  "sql security",
);
assert(!humanizeChatError("Blocked by SQL security rules: SQL-001 INSERT INTO t").includes("INSERT"), "no sql echo");
assert(
  humanizeChatError("SchemaContractError: Linked schema is missing the enum lookup table").includes("数据表不足以"),
  "schema contract",
);
assert(isCancelMessage("已取消当前请求"), "cancel detect");
assert(humanizeChatError("已运行 9 分钟后连接中断") === "已运行 9 分钟后连接中断", "disconnect copy");

console.log("chatErrors.test.ts ok");
