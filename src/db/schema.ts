import Database from 'better-sqlite3';

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 自动迁移1：检查并添加subdomain字段
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").all();
    if (tables.length > 0) {
      const columns = db.prepare("PRAGMA table_info(accounts)").all() as any[];
      const hasSubdomain = columns.some(col => col.name === 'subdomain');

      if (!hasSubdomain) {
        console.log('Running migration: Adding subdomain column to accounts table...');
        db.exec('ALTER TABLE accounts ADD COLUMN subdomain TEXT;');
        console.log('Migration completed successfully');
      }
    }
  } catch (error) {
    console.error('Migration error (subdomain):', error);
  }

  // 自动迁移2：更新jobs表的CHECK约束以支持'list'类型
  try {
    // 检查jobs表是否存在
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").all();

    if (tables.length > 0) {
      // 检查是否需要迁移（尝试插入list类型，如果失败则需要迁移）
      const needsMigration = (() => {
        try {
          // 尝试创建一个测试job
          const testId = 'migration-test-' + Date.now();
          db.prepare(`INSERT INTO jobs (id, type, status, config) VALUES (?, 'list', 'pending', '{}')`).run(testId);
          db.prepare('DELETE FROM jobs WHERE id = ?').run(testId);
          return false; // 如果成功，不需要迁移
        } catch (e) {
          return true; // 如果失败，需要迁移
        }
      })();

      if (needsMigration) {
        console.log('Running migration: Updating jobs table CHECK constraint to support "list" type...');

        // SQLite不支持直接修改CHECK约束，需要重建表
        db.exec(`
          -- 创建新表
          CREATE TABLE jobs_new (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('create', 'update', 'delete', 'query', 'list', 'health_check')),
            status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'partial', 'failed')),
            config TEXT NOT NULL,
            total_tasks INTEGER DEFAULT 0,
            completed_tasks INTEGER DEFAULT 0,
            failed_tasks INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            completed_at DATETIME
          );

          -- 复制数据
          INSERT INTO jobs_new SELECT * FROM jobs;

          -- 删除旧表
          DROP TABLE jobs;

          -- 重命名新表
          ALTER TABLE jobs_new RENAME TO jobs;
        `);

        console.log('Migration completed successfully');
      }
    }
  } catch (error) {
    console.error('Migration error (jobs table):', error);
    // 继续执行，表可能不存在
  }

  // 自动迁移3：添加last_error字段
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").all();
    if (tables.length > 0) {
      const columns = db.prepare("PRAGMA table_info(accounts)").all() as any[];
      const hasLastError = columns.some(col => col.name === 'last_error');

      if (!hasLastError) {
        console.log('Running migration: Adding last_error column to accounts table...');
        db.exec('ALTER TABLE accounts ADD COLUMN last_error TEXT;');
        console.log('Migration completed successfully');
      }
    }
  } catch (error) {
    console.error('Migration error (last_error):', error);
  }

  // 自动迁移4：添加tasks表的worker_name字段
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").all();
    if (tables.length > 0) {
      const columns = db.prepare("PRAGMA table_info(tasks)").all() as any[];
      const hasWorkerName = columns.some(col => col.name === 'worker_name');

      if (!hasWorkerName) {
        console.log('Running migration: Adding worker_name column to tasks table...');
        db.exec('ALTER TABLE tasks ADD COLUMN worker_name TEXT;');
        console.log('Migration completed successfully');
      }
    }
  } catch (error) {
    console.error('Migration error (worker_name):', error);
  }

  // 自动迁移5：更新jobs表CHECK约束以支持batch_update和batch_delete类型
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").all();

    if (tables.length > 0) {
      const needsMigration = (() => {
        try {
          const testId = 'migration-test-batch-' + Date.now();
          db.prepare(`INSERT INTO jobs (id, type, status, config) VALUES (?, 'batch_update', 'pending', '{}')`).run(testId);
          db.prepare('DELETE FROM jobs WHERE id = ?').run(testId);
          return false;
        } catch (e) {
          return true;
        }
      })();

      if (needsMigration) {
        console.log('Running migration: Updating jobs table CHECK constraint to support batch types...');

        db.exec(`
          CREATE TABLE jobs_new (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('create', 'update', 'delete', 'query', 'list', 'health_check', 'batch_update', 'batch_delete')),
            status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'partial', 'failed')),
            config TEXT NOT NULL,
            total_tasks INTEGER DEFAULT 0,
            completed_tasks INTEGER DEFAULT 0,
            failed_tasks INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            completed_at DATETIME
          );

          INSERT INTO jobs_new SELECT * FROM jobs;
          DROP TABLE jobs;
          ALTER TABLE jobs_new RENAME TO jobs;
        `);

        console.log('Migration completed successfully');
      }
    }
  } catch (error) {
    console.error('Migration error (jobs batch types):', error);
  }

  // 自动迁移6：插入script_templates初始数据
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='script_templates'").all();
    if (tables.length > 0) {
      // 检查是否已有数据
      const count = db.prepare("SELECT COUNT(*) as count FROM script_templates").get() as { count: number };

      if (count.count === 0) {
        console.log('Running migration: Inserting initial script templates...');

        const insertTemplate = db.prepare(`
          INSERT INTO script_templates (id, name, description, content, created_at, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `);

        // Hello World 模板
        insertTemplate.run('hello-world', 'Hello World', '基础模板，返回简单文本响应', `export default {
  async fetch(request, env, ctx) {
    return new Response('Hello World!', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};`);

        // 反向代理模板
        insertTemplate.run('reverse-proxy', '反向代理/转发', '转发请求到目标服务器，可修改请求头和响应头', `export default {
  async fetch(request, env, ctx) {
    const targetUrl = 'https://example.com';
    const url = new URL(request.url);

    // 构建目标URL
    const proxyUrl = new URL(url.pathname + url.search, targetUrl);

    // 复制请求，修改目标URL
    const modifiedRequest = new Request(proxyUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });

    // 转发请求
    const response = await fetch(modifiedRequest);

    // 可选：修改响应头
    const modifiedResponse = new Response(response.body, response);
    modifiedResponse.headers.set('X-Proxied-By', 'Cloudflare-Worker');

    return modifiedResponse;
  }
};`);

        // API Gateway 模板
        insertTemplate.run('api-gateway', 'API Gateway', '基础的API路由分发框架，支持不同路径处理', `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 路由分发
    switch (url.pathname) {
      case '/api/health':
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' }
        });

      case '/api/time':
        return new Response(JSON.stringify({ time: new Date().toISOString() }), {
          headers: { 'Content-Type': 'application/json' }
        });

      default:
        return new Response('Not Found', { status: 404 });
    }
  }
};`);

        console.log('Migration completed: Inserted 3 initial templates');
      }
    }
  } catch (error) {
    console.error('Migration error (script_templates seed data):', error);
  }

  // 系统配置表（存储主密码hash）
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 账号表
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auth_type TEXT CHECK(auth_type IN ('token', 'email-key')) NOT NULL,
      account_id TEXT NOT NULL,
      api_token TEXT,
      auth_email TEXT,
      auth_key TEXT,
      subdomain TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'error')),
      last_check DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 任务表
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('create', 'update', 'delete', 'query', 'list', 'health_check', 'batch_update', 'batch_delete')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'partial', 'failed')),
      config TEXT NOT NULL,
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      failed_tasks INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    )
  `);

  // 任务详情表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      worker_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'success', 'failed', 'skipped')),
      progress TEXT,
      result TEXT,
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    )
  `);

  // 脚本模板表
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Workers表（缓存账号的workers信息）
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      subdomain TEXT,
      url TEXT,
      script_hash TEXT,
      created_on DATETIME,
      modified_on DATETIME,
      last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  // 审计日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'system',
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workers_account_id ON workers(account_id);
    CREATE INDEX IF NOT EXISTS idx_workers_last_synced ON workers(last_synced DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
  `);

  return db;
}

export function getSystemConfig(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}

export function setSystemConfig(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}
