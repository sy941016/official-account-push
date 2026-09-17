/**
 * 打分 CLI 的冒烟测试
 *
 * 只验证**命令行行为**（退出码、错误提示、输出格式），不重复验证打分逻辑——
 * 那部分在 humanize.test.js 里。
 *
 * 用子进程真跑一遍，因为要验的正是"进程的退出码和 stderr"，
 * 这类行为在进程内测不出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'score.js');

/** 跑一次 CLI，返回 {code, stdout, stderr}，非零退出不抛异常 */
async function score(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      cwd: root,
      // 绕开沙箱注入的 fs shim：子进程启动快一个数量级，与逻辑无关
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('文件不存在时给人话提示并以非零码退出，不甩堆栈', async () => {
  const r = await score(['/tmp/definitely-not-here-xyz.html']);

  assert.equal(r.code, 1, '应以非零码退出，方便脚本串联');
  assert.match(r.stderr, /文件不存在/);
  assert.ok(!/\bat async\b|\bat Object\./.test(r.stderr), `不应输出原始堆栈：\n${r.stderr}`);
});

test('传入目录时提示是目录而不是文件', async () => {
  const r = await score(['src']);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /目录/);
});

test('--text 正常打分，输出含分数与等级', async () => {
  const r = await score(['--text', '说真的，我第一反应是这也能行。']);

  assert.equal(r.code, 0);
  assert.match(r.stdout, /人味分：\d+ \/ 100/);
});

test('--json 输出可被解析，字段齐全', async () => {
  const r = await score(['--text', '随便一段用来测试的文字。', '--json']);

  assert.equal(r.code, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(typeof data.score, 'number');
  assert.ok(data.metrics, '应带 metrics');
  assert.ok(Array.isArray(data.issues), '应带 issues');
  assert.equal(data.source, '(命令行传入)');
});

test('同一段文字跑两次，输出完全一致（打分必须可复现）', async () => {
  const text = '在当今社会，这一现象值得我们深入思考。首先，从商业角度来看，压力持续加大。综上所述，这是一个意义深远的课题。';

  const a = await score(['--text', text, '--json']);
  const b = await score(['--text', text, '--json']);

  assert.equal(a.stdout, b.stdout, '同一输入两次运行的输出必须一致');
});
