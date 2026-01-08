/**
 * OpenCode 插件：会话完成后自动查询 Ikuncode 账单
 *
 * 功能：
 * 1. 监听 message.updated 事件记录会话开始时间（首次或 idle 后）
 * 2. 监听 session.idle 事件自动查询账单
 * 3. 计算本次会话的消耗并显示
 * 4. 本地文件日志：写入独立日志文件，支持日志轮转
 *
 * 状态管理：
 * - 通过 isIdle 标志判断是否需要记录新的会话开始时间
 * - idle 后重置状态，下次 message.updated 时重新记录开始时间
 */

import { mkdir, stat, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// 存储会话状态：startTime（开始时间）、isIdle（是否空闲）
const sessionStates = new Map();

// 日志配置
const LOG_DIR = `${process.env.HOME}/.local/share/opencode/log/bills-auto-query`;
const LOG_FILE = join(LOG_DIR, "bills-auto-query.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 3; // 保留最近3个日志文件

/**
 * 确保日志目录存在
 */
async function ensureLogDirectory() {
  try {
    if (!existsSync(LOG_DIR)) {
      await mkdir(LOG_DIR, { recursive: true });
    }
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

/**
 * 日志轮转：当日志文件超过限制时，重命名旧文件
 */
async function rotateLogIfNeeded() {
  try {
    if (!existsSync(LOG_FILE)) {
      return;
    }

    const stats = await stat(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) {
      return;
    }

    // 轮转日志文件：.log -> .log.1 -> .log.2 -> .log.3（删除）
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldFile = `${LOG_FILE}.${i}`;
      const newFile = `${LOG_FILE}.${i + 1}`;

      if (existsSync(oldFile)) {
        if (i === MAX_LOG_FILES - 1) {
          // 删除最旧的文件
          await Bun.write(oldFile, "");
        } else {
          // 重命名文件
          await Bun.write(newFile, Bun.file(oldFile));
        }
      }
    }

    // 将当前日志文件重命名为 .log.1
    await Bun.write(`${LOG_FILE}.1`, Bun.file(LOG_FILE));
    await Bun.write(LOG_FILE, ""); // 清空当前日志文件
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

/**
 * 写入日志到本地文件
 * @param {string} level - 日志级别: debug, info, warn, error
 * @param {string} message - 日志消息
 * @param {Object} extra - 额外的结构化数据（可选）
 */
async function log(level, message, extra = {}) {
  try {
    await ensureLogDirectory();
    await rotateLogIfNeeded();

    const timestamp = new Date().toISOString();
    const levelUpper = level.toUpperCase().padEnd(5, " ");
    const extraStr =
      Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
    const logLine = `[${timestamp}] [${levelUpper}] ${message}${extraStr}\n`;

    // 使用 Node.js fs.appendFile API 追加写入日志文件（Bun 官方推荐）
    await appendFile(LOG_FILE, logLine, "utf8");
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

/**
 * 向会话注入错误通知消息
 * @param {Object} client - OpenCode client 对象
 * @param {string} sessionId - 会话ID
 * @param {string} title - 错误标题
 * @param {string} message - 错误详情
 */
async function notifyError(client, sessionId, title, message) {
  try {
    const errorMessage = `⚠️ **${title}**\n\n${message}`;
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: errorMessage }],
      },
    });
  } catch (err) {
    // 静默失败，避免死循环（如果消息注入本身失败）
  }
}

/**
 * 获取或初始化会话状态
 */
function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, { startTime: null, isIdle: true });
  }
  return sessionStates.get(sessionId);
}

export const BillsAutoQueryPlugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  return {
    event: async ({ event }) => {
      // 监听 message.updated 事件，记录会话开始时间
      if (event.type === "message.updated") {
        const sessionId = event.properties.info.sessionID;
        const state = getSessionState(sessionId);

        // 如果是空闲状态或未记录开始时间，则记录为新会话的开始
        if (state.isIdle || !state.startTime) {
          state.startTime = new Date();
          state.isIdle = false;

          await log(
            "info",
            `会话 ${sessionId} 开始，记录时间: ${state.startTime.toLocaleString("zh-CN")}`,
            { sessionId, trigger: "message.updated" },
          );
        }
      }

      // 会话完成时自动查询账单
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        const state = getSessionState(sessionId);
        const startTime = state.startTime;

        if (!startTime) {
          await log("debug", "未找到会话开始时间，跳过账单查询", { sessionId });
          return;
        }

        await log("info", "会话已完成，正在查询账单消耗...", { sessionId });

        try {
          // 获取计费工具路径，支持环境变量配置
          const billingToolPath =
            process.env.BILLING_TOOL_PATH ||
            `${process.env.HOME}/.local/bin/billing-tool`;

          // 检查工具是否存在
          const toolExists = await Bun.file(billingToolPath).exists();
          if (!toolExists) {
            const errorMsg = `计费工具未找到: ${billingToolPath}，请设置 BILLING_TOOL_PATH 环境变量或将工具安装到默认路径`;
            await log("error", errorMsg);
            await notifyError(
              client,
              sessionId,
              "计费工具不可用",
              `无法查询账单消耗，请检查计费工具配置。\n\n路径: \`${billingToolPath}\``,
            );
            return;
          }

          // 计算时间戳（秒级）
          const MS_TO_SECONDS = 1000;
          const startTimestamp = Math.floor(
            startTime.getTime() / MS_TO_SECONDS,
          );
          const endTimestamp = Math.floor(Date.now() / MS_TO_SECONDS);

          await log(
            "debug",
            `时间范围: ${startTimestamp} - ${endTimestamp} (${endTimestamp - startTimestamp}秒)`,
            { startTimestamp, endTimestamp },
          );

          // 调用 Go 工具查询账单
          const proc = Bun.spawn(
            [
              billingToolPath,
              "--start-time",
              startTimestamp.toString(),
              "--end-time",
              endTimestamp.toString(),
            ],
            {
              stdout: "pipe", // 捕获 stdout
              stderr: "pipe", // 捕获 stderr
            },
          );

          const output = await new Response(proc.stdout).text();
          const exitCode = await proc.exited;

          if (exitCode !== 0) {
            const errorOutput = await new Response(proc.stderr).text();
            const errorMsg = `计费工具执行失败 (退出码: ${exitCode}): \n${output}\n${errorOutput}`;
            await log("error", errorMsg, { sessionId, exitCode });
            await notifyError(client, sessionId, "账单查询失败", errorMsg);
            return;
          }

          // 从输出中提取统计信息
          const recordMatch = output.match(/记录数:\s+(\d+)\s+条/);
          const costMatch = output.match(
            /总费用:\s+¥([\d.]+)\s+\(([\d.]+)元\)/,
          );
          const inputTokenMatch = output.match(/总输入Token:\s+([\d,]+)/);
          const outputTokenMatch = output.match(/总输出Token:\s+([\d,]+)/);
          const totalTokenMatch = output.match(/总Token:\s+([\d,]+)/);

          if (recordMatch && costMatch) {
            const recordCount = recordMatch[1];
            const costDetailed = costMatch[1];
            const inputTokens = inputTokenMatch ? inputTokenMatch[1] : "0";
            const outputTokens = outputTokenMatch ? outputTokenMatch[1] : "0";
            const totalTokens = totalTokenMatch ? totalTokenMatch[1] : "0";

            // 计算会话时长
            const duration = Math.floor(
              (Date.now() - startTime.getTime()) / MS_TO_SECONDS,
            );
            const minutes = Math.floor(duration / 60);
            const seconds = duration % 60;
            const durationStr =
              minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

            // 向会话注入账单统计消息（用户在 TUI 对话中直接看到）
            const billSummary = `💰 **本次会话账单统计**
⏰ 会话时长: ${durationStr}
📝 API 调用: ${recordCount} 次
💰 总费用: ¥${costDetailed}
📥 输入 Token: ${inputTokens}
📤 输出 Token: ${outputTokens}
📊 总 Token: ${totalTokens}`;

            try {
              // 向当前会话注入消息（noReply: true 表示不触发 AI 响应）
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  noReply: true,
                  parts: [{ type: "text", text: billSummary }],
                },
              });

              // 记录详细的账单统计日志
              await log(
                "info",
                `账单统计完成: ${recordCount}次调用, ¥${costDetailed}元`,
                {
                  sessionId,
                  duration: durationStr,
                  recordCount: parseInt(recordCount),
                  cost: parseFloat(costDetailed),
                  tokens: {
                    input: inputTokens,
                    output: outputTokens,
                    total: totalTokens,
                  },
                },
              );
            } catch (error) {
              // 如果注入消息失败，记录详细错误
              await log("warn", `无法向会话注入账单信息: ${error.message}`, {
                sessionId,
                error: error.stack,
              });
            }
          } else {
            await log("info", "本次会话未产生费用或无法解析统计信息");
          }
        } catch (error) {
          await log("error", `查询账单失败: ${error.message}`, {
            sessionId,
            error: error.stack,
          });
          await notifyError(
            client,
            sessionId,
            "账单查询异常",
            `查询账单时发生未预期的错误:\n\n\`\`\`\n${error.message}\n\`\`\`\n\n请查看日志文件获取详细信息: \`${LOG_FILE}\``,
          );
        } finally {
          // 重置会话状态为空闲，清空开始时间
          state.isIdle = true;
          state.startTime = null;

          await log("info", `会话 ${sessionId} 已重置为空闲状态`, {
            sessionId,
          });
        }
      }
    },
  };
};
