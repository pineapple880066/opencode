-- MySQL 8+ 初始 schema
-- 设计原则：
-- 1. MySQL 是 durable state 的真相源
-- 2. JSON 字段用于结构化内容，避免把 plan / summary / message 退化成纯文本
-- 3. Redis 不替代这些表，只做缓存和协作辅助

CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  path VARCHAR(1024) NOT NULL,
  path_hash CHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_workspaces_path_hash (path_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  parent_session_id VARCHAR(64) NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  agent_mode VARCHAR(32) NOT NULL,
  active_goal_id VARCHAR(64) NULL,
  summary_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  archived_at DATETIME(3) NULL,
  KEY idx_sessions_workspace_id (workspace_id),
  KEY idx_sessions_parent_session_id (parent_session_id),
  KEY idx_sessions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goals (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  success_criteria_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  KEY idx_goals_session_id (session_id),
  KEY idx_goals_workspace_id (workspace_id),
  KEY idx_goals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plans (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  goal_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  summary TEXT NOT NULL,
  steps_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_plans_goal_id (goal_id),
  KEY idx_plans_session_id (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  goal_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NULL,
  session_id VARCHAR(64) NOT NULL,
  owner_agent VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  input_summary TEXT NOT NULL,
  output_summary TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_tasks_session_id (session_id),
  KEY idx_tasks_goal_id (goal_id),
  KEY idx_tasks_plan_id (plan_id),
  KEY idx_tasks_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_messages_session_id (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memory_records (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NULL,
  scope VARCHAR(32) NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `value` TEXT NOT NULL,
  source VARCHAR(32) NOT NULL,
  confidence DECIMAL(5,4) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_memory_workspace_scope (workspace_id, scope),
  KEY idx_memory_session_scope (session_id, scope),
  KEY idx_memory_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subagent_runs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  parent_session_id VARCHAR(64) NOT NULL,
  child_session_id VARCHAR(64) NOT NULL,
  parent_task_id VARCHAR(64) NULL,
  agent_mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  result_summary TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_subagent_parent_session_id (parent_session_id),
  KEY idx_subagent_child_session_id (child_session_id),
  KEY idx_subagent_parent_task_id (parent_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS checkpoints (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  node VARCHAR(64) NOT NULL,
  state_json JSON NOT NULL,
  summary TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_checkpoints_session_id (session_id),
  KEY idx_checkpoints_node (node)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
  thread_id VARCHAR(128) NOT NULL,
  checkpoint_ns VARCHAR(128) NOT NULL DEFAULT '',
  checkpoint_id VARCHAR(64) NOT NULL,
  parent_checkpoint_id VARCHAR(64) NULL,
  checkpoint_b64 LONGTEXT NOT NULL,
  metadata_b64 LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id),
  KEY idx_langgraph_parent_checkpoint (thread_id, checkpoint_ns, parent_checkpoint_id),
  KEY idx_langgraph_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
  thread_id VARCHAR(128) NOT NULL,
  checkpoint_ns VARCHAR(128) NOT NULL DEFAULT '',
  checkpoint_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  write_idx INT NOT NULL,
  channel_name VARCHAR(128) NOT NULL,
  value_b64 LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx),
  KEY idx_langgraph_writes_checkpoint (thread_id, checkpoint_ns, checkpoint_id),
  KEY idx_langgraph_writes_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tool_invocations (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(64) NULL,
  subagent_run_id VARCHAR(64) NULL,
  tool_name VARCHAR(64) NOT NULL,
  input_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  output_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_tool_invocations_session_id (session_id),
  KEY idx_tool_invocations_task_id (task_id),
  KEY idx_tool_invocations_subagent_run_id (subagent_run_id),
  KEY idx_tool_invocations_tool_name (tool_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
