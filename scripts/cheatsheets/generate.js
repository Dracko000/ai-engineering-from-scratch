'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sheets = require('../../site/build-cheatsheets');
const topicMap = require('../../site/cheatsheet-topics');

const ROOT = path.resolve(__dirname, '..', '..');
const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const DEFAULT_MODEL = MODELS.sonnet;
const MAX_RETRIES = 2;
const MAX_TOKENS = 64000;
const MAX_FILE_CHARS = 60000;
const MAX_BUNDLE_CHARS = 600000;
const EXAMPLE_TOPIC = 'sglang-serving';
const FRONT_KEYS = ['id', 'title', 'code', 'subtitle', 'hue', 'sources', 'source_hash'];

function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function filePriority(file) {
  if (/\/docs\/en\.md$/.test(file) || /\/README\.md$/.test(file)) return 0;
  if (/\/sections\//.test(file) || /\/API\.md$/.test(file)) return 1;
  if (/\.md$/.test(file)) return 2;
  if (/\/(?:code|solution)\//.test(file)) return 3;
  return 4;
}

function sourceBundle(entry, root = ROOT) {
  const files = entry.sources.flatMap(source => topicMap.sourceFiles(source, root));
  const ranked = files.map((file, index) => ({ file, index, size: fs.statSync(path.join(root, file)).size })).sort((a, b) => filePriority(a.file) - filePriority(b.file) || a.index - b.index);
  const kept = [];
  const omitted = [];
  let total = 0;
  for (const item of ranked) {
    if (item.size > MAX_FILE_CHARS || total + item.size > MAX_BUNDLE_CHARS) {
      omitted.push(item.file);
      continue;
    }
    kept.push(item);
    total += item.size;
  }
  kept.sort((a, b) => a.index - b.index);
  const text = kept.map(item => `=== ${item.file} ===\n${readText(root, item.file)}`).join('\n\n');
  return { text, files: kept.map(item => item.file), omitted, chars: total };
}

function systemPrompt(root = ROOT) {
  const parts = [
    readText(root, 'scripts/cheatsheets/prompt.md'),
    `## The authoring guide (cheatsheets/AUTHORING.md)\n\n${readText(root, 'cheatsheets/AUTHORING.md')}`,
  ];
  const example = `cheatsheets/${EXAMPLE_TOPIC}.md`;
  const evidence = `cheatsheets/evidence/${EXAMPLE_TOPIC}.md`;
  if (fs.existsSync(path.join(root, example))) parts.push(`## A finished poster (${example})\n\n${readText(root, example)}`);
  if (fs.existsSync(path.join(root, evidence))) parts.push(`## Its evidence file (${evidence})\n\n${readText(root, evidence)}`);
  return parts.join('\n\n');
}

function userPrompt(entry, bundle) {
  const omitted = bundle.omitted.length ? `\nThese source files were too large to include. Do not cite facts from them: ${bundle.omitted.join(', ')}\n` : '';
  return `Write the poster and the evidence file for this topic.

id: ${entry.id}
title: ${entry.title}
kind: ${entry.kind}
sources: ${entry.sources.join(', ')}
${omitted}
The source files follow.

${bundle.text}`;
}

function parseReply(text) {
  const topic = /<topic>\s*([\s\S]*?)\s*<\/topic>/.exec(text);
  const evidence = /<evidence>\s*([\s\S]*?)\s*<\/evidence>/.exec(text);
  if (!topic || !evidence) return { error: 'The reply must hold one <topic> part and one <evidence> part.' };
  return { topic: topic[1].replace(/^```[a-z]*\n/, '').replace(/\n```$/, ''), evidence: evidence[1] };
}

function splitFrontMatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (match) meta[match[1]] = match[2].trim();
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function codeCandidates(title) {
  const words = title.replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(word => word && !/^(?:and|with|the|of|for|to|a|an|in|on|from|against)$/i.test(word)).map(word => word.toUpperCase());
  const out = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) out.push(words[i][0] + words[j][0]);
    for (let k = 1; k < words[i].length; k++) out.push(words[i][0] + words[i][k]);
  }
  for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') out.push(a + b);
  return out.filter(code => /^[A-Z][A-Z0-9]$/.test(code));
}

function pickCode(entry, current, taken) {
  if (current && /^[A-Z][A-Z0-9]$/.test(current) && !taken.has(current)) return current;
  return codeCandidates(entry.title).find(code => !taken.has(code));
}

function takenCodes(root, exceptId) {
  const taken = new Set();
  for (const topic of sheets.loadTopics(root)) if (topic.id !== exceptId) taken.add(topic.code);
  return taken;
}

function normalizeTopic(text, entry, root = ROOT, taken = takenCodes(root, entry.id)) {
  const split = splitFrontMatter(text);
  if (!split) return { error: 'The poster must start with a front matter block between two "---" lines.' };
  const meta = {
    id: entry.id,
    title: entry.title,
    code: pickCode(entry, split.meta.code, taken),
    subtitle: split.meta.subtitle || '',
    hue: split.meta.hue || '222',
    sources: entry.sources.join(', '),
    source_hash: topicMap.sourceHash(entry.sources, root),
  };
  const head = FRONT_KEYS.map(key => `${key}: ${meta[key]}`).join('\n');
  return { text: `---\n${head}\n---\n${split.body.replace(/^\n*/, '\n').replace(/\s*$/, '\n')}` };
}

function checkText(text, entry, root = ROOT) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheatsheet-')), `${entry.id}.md`);
  fs.writeFileSync(file, text);
  const topic = sheets.parseTopic(text, file);
  topic.file = `cheatsheets/${entry.id}.md`;
  const problems = sheets.checkTopic(topic, root).map(problem => problem.replace(`${topic.file}: `, ''));
  problems.push(...scopeProblems(topic, entry));
  return problems;
}

function scopeProblems(topic, entry) {
  const problems = [];
  for (const block of topic.blocks) {
    for (const source of block.from) {
      const plainPath = path.posix.normalize(source) === source && !source.split('/').includes('..');
      if (!plainPath || !entry.sources.some(allowed => source === allowed || source.startsWith(`${allowed}/`))) problems.push(`block "${block.title}" names ${source}, which is not a source of this topic`);
    }
  }
  return problems;
}

function evidenceProblems(evidence, topicText, entry) {
  const problems = [];
  const lines = evidence.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== `# Evidence: cheatsheets/${entry.id}.md`) problems.push(`the evidence file must start with "# Evidence: cheatsheets/${entry.id}.md"`);
  const sections = [];
  for (const line of lines) {
    if (line.startsWith('## ')) sections.push({ title: line.slice(3), refs: 0 });
    else if (sections.length && /^\s*(?:[-*]|\d+\.)\s.*:\d+/.test(line)) sections[sections.length - 1].refs += 1;
  }
  const topic = sheets.parseTopic(topicText, `${entry.id}.md`);
  for (const block of topic.blocks) {
    const section = sections.find(item => item.title.includes(block.title));
    if (!section) problems.push(`the evidence file has no section for the block "${block.title}"`);
    else if (!section.refs) problems.push(`the evidence section for "${block.title}" gives no path:line`);
  }
  return problems;
}

function replyText(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

async function callModel(client, { model, system, messages }) {
  const stream = client.beta.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  });
  return stream.finalMessage();
}

async function generateTopic({ entry, client, model = DEFAULT_MODEL, root = ROOT, log = () => {}, write = true }) {
  const bundle = sourceBundle(entry, root);
  if (bundle.omitted.length) log(`${entry.id}: left out ${bundle.omitted.length} large source files: ${bundle.omitted.join(', ')}`);
  const system = systemPrompt(root);
  const messages = [{ role: 'user', content: userPrompt(entry, bundle) }];
  let problems = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const message = await callModel(client, { model, system, messages });
    if (message.stop_reason === 'refusal') return { id: entry.id, ok: false, attempts: attempt + 1, problems: ['the model declined the request'] };
    if (message.stop_reason === 'max_tokens') problems = ['the reply reached the token limit before it finished'];
    else {
      const reply = parseReply(replyText(message));
      if (reply.error) problems = [reply.error];
      else {
        const normal = normalizeTopic(reply.topic, entry, root);
        problems = normal.error ? [normal.error] : checkText(normal.text, entry, root).concat(evidenceProblems(reply.evidence, normal.text, entry));
        if (!problems.length) {
          if (write) {
            fs.writeFileSync(path.join(root, 'cheatsheets', `${entry.id}.md`), normal.text);
            fs.mkdirSync(path.join(root, 'cheatsheets', 'evidence'), { recursive: true });
            fs.writeFileSync(path.join(root, 'cheatsheets', 'evidence', `${entry.id}.md`), `${reply.evidence.replace(/\s*$/, '')}\n`);
          }
          log(`${entry.id}: passed on attempt ${attempt + 1}`);
          return { id: entry.id, ok: true, attempts: attempt + 1, problems: [] };
        }
      }
    }
    log(`${entry.id}: attempt ${attempt + 1} has ${problems.length} problems`);
    if (attempt === MAX_RETRIES) break;
    messages.push({ role: 'assistant', content: message.content });
    messages.push({ role: 'user', content: `The build found these problems in your poster:\n\n${problems.map(problem => `- ${problem}`).join('\n')}\n\nReply again with both complete files, fixed.` });
  }
  return { id: entry.id, ok: false, attempts: MAX_RETRIES + 1, problems };
}

function stampTopic(entry, root = ROOT) {
  const file = path.join(root, 'cheatsheets', `${entry.id}.md`);
  const normal = normalizeTopic(fs.readFileSync(file, 'utf8'), entry, root);
  if (normal.error) throw new Error(`${entry.id}: ${normal.error}`);
  const scope = scopeProblems(sheets.parseTopic(normal.text, file), entry);
  if (scope.length) throw new Error(`${entry.id}: ${scope.join('. ')}. Change the from lines first.`);
  fs.writeFileSync(file, normal.text);
}

function resolveModel(name) {
  return MODELS[name] || name || DEFAULT_MODEL;
}

function createClient() {
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default || sdk;
  return new Anthropic();
}

function status(root = ROOT) {
  return topicMap.mapStatus(topicMap.loadTopicMap(root), sheets.loadTopics(root), root);
}

async function main(argv, { client, root = ROOT, out = console } = {}) {
  const flag = name => argv.includes(name);
  const value = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const map = topicMap.loadTopicMap(root);
  if (map.errors.length) {
    for (const error of map.errors) out.error(error);
    return 1;
  }
  const byId = new Map(map.topics.map(entry => [entry.id, entry]));
  const current = status(root);
  if (flag('--status')) {
    out.log(JSON.stringify(current, null, 2));
    return 0;
  }
  const valueFlags = new Set(['--model', '--limit', '--summary']);
  const named = argv.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(argv[index - 1]));
  let ids = named.length ? named : [];
  if (flag('--missing')) ids = ids.concat(current.missing);
  if (flag('--stale')) ids = ids.concat(current.stale);
  ids = Array.from(new Set(ids));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length) {
    out.error(`Unknown topics: ${unknown.join(', ')}`);
    return 1;
  }
  const limit = Number(value('--limit')) || ids.length;
  ids = ids.slice(0, limit);
  if (flag('--stamp')) {
    for (const id of ids) stampTopic(byId.get(id), root);
    out.log(`Stamped ${ids.length} sheets.`);
    return 0;
  }
  if (!ids.length) {
    out.log('No topic to write.');
    return 0;
  }
  if (flag('--dry-run')) {
    for (const id of ids) {
      const bundle = sourceBundle(byId.get(id), root);
      out.log(`${id}: ${bundle.files.length} files, ${bundle.chars} characters${bundle.omitted.length ? `, ${bundle.omitted.length} left out` : ''}`);
    }
    return 0;
  }
  if (!client && !process.env.ANTHROPIC_API_KEY) {
    out.error('ANTHROPIC_API_KEY is not set.');
    return 2;
  }
  const api = client || createClient();
  const model = resolveModel(value('--model'));
  const results = [];
  for (const id of ids) {
    try {
      results.push(await generateTopic({ entry: byId.get(id), client: api, model, root, log: line => out.log(line) }));
    } catch (error) {
      results.push({ id, ok: false, attempts: 0, problems: [String(error && error.message || error)] });
      out.error(`${id}: ${error && error.message || error}`);
    }
  }
  const summary = { model, written: results.filter(result => result.ok).map(result => result.id), failed: results.filter(result => !result.ok) };
  if (value('--summary')) fs.writeFileSync(value('--summary'), `${JSON.stringify(summary, null, 2)}\n`);
  out.log(`Wrote ${summary.written.length} sheets. ${summary.failed.length} topics failed.`);
  for (const failure of summary.failed) out.error(`${failure.id}: ${failure.problems.slice(0, 5).join(' | ')}`);
  return summary.failed.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { MODELS, DEFAULT_MODEL, MAX_RETRIES, sourceBundle, systemPrompt, userPrompt, parseReply, normalizeTopic, checkText, evidenceProblems, scopeProblems, generateTopic, stampTopic, codeCandidates, main };
