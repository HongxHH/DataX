/** 用户可见错误文案。后端 ``app._user_facing_error_text`` 有平行映射，改文案时请两边一起看。 */
export function humanizeChatError(raw: string, isAbort = false): string {
  if (isAbort) return "已取消当前请求";
  const text = String(raw ?? "")
    .trim()
    .replace(/^(错误：|请求失败：)+/, "");
  if (!text || text === "Failed to fetch") {
    return "无法连接后端。请确认 8788 已启动后刷新页面再试。";
  }
  if (/Chat failed:\s*5\d\d/i.test(text)) {
    return "后端处理失败，请稍后重试。";
  }
  if (/Chat failed:\s*4\d\d/i.test(text)) {
    return "请求未被接受，请刷新页面后重试。";
  }
  if (text.includes("未收到最终结果")) {
    return "生成已结束，但没有收到最终结论。请重新提问。";
  }
  if (text.includes("连接中断")) {
    return text;
  }
  if (/semantic|语义层/i.test(text)) {
    return "语义层暂时不可用。请确认 Semantic Service（:32000）已启动后重试。";
  }
  if (/timeout|timed out|超时/i.test(text)) {
    return "等待模型或子 Agent 超时，请稍后重试。";
  }
  if (/workspace is busy|workspacebusyerror|工作区正被占用/i.test(text)) {
    return "当前会话工作区正被占用。请等待上一轮结束，或先停止生成后再试。";
  }
  if (/already running|本次未启动/.test(text)) {
    return "子 Agent 正在运行。请停止当前生成，或换一个新的 worker 再问。";
  }
  if (
    /NL2SQL-SEC-001|Blocked by SQL security|生成的 SQL 未通过安全校验|SQLSecurityValidationError|Only read-only SELECT|sql security rules/i.test(
      text,
    )
  ) {
    return "该查询被安全规则拦截，只允许只读 SELECT。请改问后再试。";
  }
  return text;
}

export function isCancelMessage(text: string | undefined): boolean {
  return Boolean(text?.includes("已取消"));
}
