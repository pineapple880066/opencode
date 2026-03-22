import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

export interface WorkspaceEnvOptions {
  cwd?: string;
  targetEnv?: NodeJS.ProcessEnv;
  filenames?: string[];
}

// 这里做的是“工作区级别的 .env 自动加载”。
// 规则是：优先保留用户当前 shell 已经 export 的变量；如果 shell 里没有，再从 .env / .env.local 补。
export function loadWorkspaceEnv(options?: WorkspaceEnvOptions): NodeJS.ProcessEnv {
  const cwd = options?.cwd ?? process.cwd();
  const targetEnv = options?.targetEnv ?? process.env;
  const filenames = options?.filenames ?? [".env", ".env.local"];
  const merged: Record<string, string> = {};

  for (const filename of filenames) {
    const filePath = resolve(cwd, filename);
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parse(readFileSync(filePath));
    Object.assign(merged, parsed);
  }

  for (const [key, value] of Object.entries(merged)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }

  return targetEnv;
}
