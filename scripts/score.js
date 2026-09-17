#!/usr/bin/env node
/**
 * 人味自检 CLI
 *
 * 用来在本地快速看一篇文章"AI 味"有多重，不用每次都去检测平台点一遍。
 * 注意：这是**代理指标**，按朱雀那类检测器的公开原理（困惑度 / 结构规律性 / 词汇分布）
 * 做的统计近似，分数不等于朱雀的真实输出，但用来做 A/B 对比非常有效。
 * 最终结论仍以朱雀的实际检测为准。
 *
 * 用法：
 *   npm run score -- article.html          # 读文件（HTML 或纯文本都行）
 *   npm run score -- --text "要检测的文字"
 *   cat article.html | npm run score       # 从标准输入读
 *   npm run score -- article.html --json   # 输出 JSON，方便脚本消费
 */
import { readFile } from 'fs/promises';
import { scoreHumanity, extractSpecifics, HUMANITY_TARGETS as T } from '../src/ai/humanize.js';

const BAR_WIDTH = 20;

/** 终端里画一个 0-100 的进度条 */
function bar(value) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * BAR_WIDTH);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

/**
 * 按**显示宽度**补空格。
 * 不能用 String.padEnd：它按 UTF-16 长度算，而中文/全角字符在终端占两列，
 * 结果就是中文一多整个表格就歪了。
 */
function padTo(text, target) {
  const s = String(text);
  const width = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x1100 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, target - width));
}

const LABELS = {
  burstiness: '句长波动（突发性）',
  shortSentences: '短句密度',
  longSentences: '长句密度',
  paragraphRhythm: '段落参差度',
  singleSentencePara: '单句成段',
  phraseFree: '无 AI 套话',
  concreteness: '具体细节',
  oral: '口语感',
  punctuation: '标点多样性',
};

/** 把指标和期望值并排展示，一眼看出差在哪 */
function metricRows(m) {
  return [
    ['平均句长', `${m.avgSentenceLen} 字`, '20-40 字'],
    ['句长变异系数', m.sentenceLenCV, `≥ ${T.sentenceLenCV}`],
    ['≤10 字短句占比', `${(m.shortSentenceRatio * 100).toFixed(1)}%`, `≥ ${(T.shortSentenceRatio * 100).toFixed(0)}%`],
    ['≥45 字长句占比', `${(m.longSentenceRatio * 100).toFixed(1)}%`, `≥ ${(T.longSentenceRatio * 100).toFixed(0)}%`],
    ['段落数', m.paragraphCount, '—'],
    ['段落长度', `${m.paraMinLen} ~ ${m.paraMaxLen} 字`, '最短 ≤35，最长 ≥180'],
    ['段落长度变异系数', m.paraLenCV, `≥ ${T.paraLenCV}`],
    ['单句成段占比', `${(m.singleSentenceParaRatio * 100).toFixed(1)}%`, `≥ ${(T.singleSentenceParaRatio * 100).toFixed(0)}%`],
    ['AI 套话密度', `${m.aiPhraseDensity} 处/千字`, `≤ ${T.aiPhraseDensity}`],
    ['具体细节密度', `${m.concreteDensity} 个/千字`, `≥ ${T.concreteDensity}`],
    ['口语标记密度', `${m.oralDensity} 个/千字`, `≥ ${T.oralDensity}`],
    ['标点种类', m.punctuationTypes.join(' ') || '（无）', `≥ ${T.punctuationVariety} 种`],
    ['排比/对仗', `${m.structuralRepetition} 处句内 + ${m.parallelFrames} 类框架`, '0'],
  ];
}

async function readInput(argv) {
  const textFlag = argv.indexOf('--text');
  if (textFlag !== -1) {
    const value = argv[textFlag + 1];
    if (!value) throw new Error('--text 后面要跟文本内容');
    return { label: '(命令行传入)', content: value };
  }

  const file = argv.find((a) => !a.startsWith('--'));
  if (file) {
    try {
      return { label: file, content: await readFile(file, 'utf-8') };
    } catch (err) {
      // 文件名打错一个字就甩一整段堆栈，对用户没有任何帮助。给一句人话。
      const reason =
        err.code === 'ENOENT'
          ? '文件不存在'
          : err.code === 'EISDIR'
            ? '这是一个目录，不是文件'
            : err.code === 'EACCES'
              ? '没有读取权限'
              : err.message;
      console.error(`读不了 ${file}：${reason}`);
      process.exit(1);
    }
  }

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString('utf-8');
    if (content.trim()) return { label: '(标准输入)', content };
  }

  return null;
}

const argv = process.argv.slice(2);
const input = await readInput(argv);

if (!input) {
  console.error('用法: npm run score -- <文件>  |  --text "文本"  |  cat file | npm run score');
  process.exit(1);
}

const report = scoreHumanity(input.content);

if (argv.includes('--json')) {
  console.log(JSON.stringify({ source: input.label, ...report }, null, 2));
  process.exit(0);
}

console.log(`\n来源：${input.label}`);
console.log(`全文 ${report.metrics.charCount} 字 / ${report.metrics.sentenceCount} 句 / ${report.metrics.paragraphCount} 段\n`);
console.log(`人味分：${report.score} / 100  （${report.grade}）\n`);

console.log('各维度得分');
for (const [key, value] of Object.entries(report.breakdown).sort((a, b) => a[1] - b[1])) {
  console.log(`  ${padTo(LABELS[key], 22)}${bar(value)} ${String(value).padStart(3)}`);
}

console.log('\n关键指标');
for (const [name, actual, target] of metricRows(report.metrics)) {
  console.log(`  ${padTo(name, 22)}${padTo(actual, 30)}目标 ${target}`);
}

console.log('\n具体信息清单');
// 把"具体细节"这一项到底数了什么摊开给用户看。
// 这一项只统计数量、**不检查真假**，而提示词又要求"至少 3 处具体细节"——
// 两者合起来会诱导模型编数字。摊开清单，用户才能判断这些数字和引语是不是真的。
const specifics = extractSpecifics(input.content);
console.log(`  数字 ${specifics.numbers.length} 个：${specifics.numbers.join(' / ') || '（无）'}`);
if (specifics.quotes.length) {
  console.log(`  引语 ${specifics.quotes.length} 处：`);
  for (const q of specifics.quotes) console.log(`    ${q}`);
} else {
  console.log('  引语 0 处');
}
console.log('  ⚠️ 只统计数量，不核对真假——发布前请自行核对上面这些数字和引语。');

console.log('\n问题清单');
if (report.issues.length === 0) console.log('  没有明显问题。');
else for (const issue of report.issues) console.log(`  · ${issue}`);

console.log(
  '\n提示：这是按检测器公开原理做的统计近似，用于横向对比；' +
    '最终请以朱雀的实际检测结果为准。\n'
);
