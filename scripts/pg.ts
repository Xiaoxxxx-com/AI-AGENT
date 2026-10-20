/**
 * 便携版 PostgreSQL 控制脚本（Windows 免安装、不需要管理员权限）。
 *
 *   pnpm pg:setup    初始化数据目录 + 启动 + 建库 + 建扩展（一次即可）
 *   pnpm pg:start    启动
 *   pnpm pg:stop     停止
 *   pnpm pg:status   查看状态
 *   pnpm pg:psql     进入 psql
 *
 * 前提：PostgreSQL 便携版已解压到 var/pg/pgsql，pgvector 已放入其 lib/ 与 share/extension/。
 * 相关变量（.env 或环境变量）：
 *   PG_BIN  var/pg/pgsql/bin
 *   PGDATA_DIR  var/pgdata
 *   PGPORT  从 DATABASE_URL 解析，默认 5432
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.resolve(ROOT, process.env.PG_BIN ?? 'var/pg/pgsql/bin');
const DATA = path.resolve(ROOT, process.env.PGDATA_DIR ?? 'var/pgdata');
const LOG = path.resolve(ROOT, 'var/pg.log');

function url() {
  try {
    return new URL(process.env.DATABASE_URL ?? 'postgres://companion:companion_dev@127.0.0.1:5432/companion');
  } catch {
    throw new Error('DATABASE_URL 不是合法的 postgres 连接串');
  }
}

const PORT = url().port || '5432';
const USER = decodeURIComponent(url().username || 'companion');
const DB = url().pathname.replace(/^\//, '') || 'companion';

function exe(name: string): string {
  const file = path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);
  if (!existsSync(file)) {
    throw new Error(
      `找不到 ${file}\n` +
        `请先解压 PostgreSQL 便携版到 var/pg/（让 pg_ctl 位于 var/pg/pgsql/bin/），或用 docker compose up -d 起容器。`,
    );
  }
  return file;
}

function run(name: string, args: string[], opts: { allowFail?: boolean; quiet?: boolean } = {}) {
  const res = spawnSync(exe(name), args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'companion_dev' },
  });
  if (!opts.quiet) {
    if (res.stdout?.trim()) process.stdout.write(res.stdout);
    if (res.stderr?.trim()) process.stderr.write(res.stderr);
  }
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${name} 退出码 ${res.status}`);
  }
  return res;
}

function status(): string {
  if (!existsSync(path.join(DATA, 'PG_VERSION'))) return 'no-data-dir';
  const res = spawnSync(exe('pg_ctl'), ['-D', DATA, 'status'], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? 'running' : 'stopped';
}

function initSqlConf() {
  const conf = path.join(DATA, 'postgresql.conf');
  const current = readFileSync(conf, 'utf8');
  if (current.includes('# --- companion dev overrides ---')) return;

  appendFileSync(
    conf,
    `
# --- companion dev overrides ---
port = ${PORT}
listen_addresses = '127.0.0.1'
shared_buffers = 512MB
work_mem = 32MB
maintenance_work_mem = 256MB
max_connections = 50
log_min_duration_statement = 200
log_timezone = 'Asia/Shanghai'
timezone = 'Asia/Shanghai'
`,
  );
}

function setup() {
  if (!existsSync(path.join(DATA, 'PG_VERSION'))) {
    console.log(`[pg] initdb → ${DATA}`);
    mkdirSync(path.dirname(DATA), { recursive: true });
    // trust 认证：只监听 127.0.0.1，密码不会被校验；连接串里的密码留着是为了和 Docker 版一致
    run('initdb', ['-D', DATA, '-U', USER, '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  } else {
    console.log('[pg] 数据目录已存在，跳过 initdb');
  }

  initSqlConf();

  if (status() !== 'running') start();
  else console.log('[pg] 已在运行');

  const check = run('psql', ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', 'postgres', '-tAc', `select 1 from pg_database where datname='${DB}'`], { quiet: true });
  if (!check.stdout?.trim()) {
    console.log(`[pg] createdb ${DB}`);
    run('createdb', ['-h', '127.0.0.1', '-p', PORT, '-U', USER, DB]);
  }

  console.log('[pg] 创建扩展');
  run('psql', ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-c',
    'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;']);

  const ver = run('psql', ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', DB, '-tAc',
    "select 'pgvector ' || extversion from pg_extension where extname = 'vector'"], { quiet: true });
  console.log(`[pg] ok · ${ver.stdout?.trim() || 'vector 未安装'} · ${PORT}/${DB}`);
  console.log('[pg] 下一步：pnpm db:migrate && pnpm db:seed');
}

function start() {
  if (status() === 'no-data-dir') {
    throw new Error('还没有数据目录，先跑 pnpm pg:setup');
  }
  mkdirSync(path.dirname(LOG), { recursive: true });
  run('pg_ctl', ['-D', DATA, '-l', LOG, '-w', 'start']);
  const ver = run('psql', ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', DB, '-tAc', 'select version()'], { quiet: true, allowFail: true });
  console.log(`[pg] started · ${ver.stdout?.trim() ?? `日志见 ${LOG}`}`);
}

function stop() {
  if (status() !== 'running') {
    console.log('[pg] 未运行');
    return;
  }
  run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', 'stop']);
  console.log('[pg] stopped');
}

function psql() {
  const args = ['-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', DB];
  const res = spawnSync(exe('psql'), args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
  process.exit(res.status ?? 0);
}

const cmd = process.argv[2] ?? 'status';

try {
  const s = status();
  switch (cmd) {
    case 'setup':
      setup();
      break;
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
      console.log(`[pg] ${s}${s === 'running' ? ` · 127.0.0.1:${PORT}/${DB}` : ''} · data=${DATA}`);
      break;
    case 'psql':
      psql();
      break;
    default:
      console.error(`未知命令：${cmd}（可用 setup | start | stop | status | psql）`);
      process.exit(1);
  }
} catch (err) {
  console.error(`[pg] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
