'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const generate = require('./generate');
const topicMap = require('../../site/cheatsheet-topics');

const REPO = path.resolve(__dirname, '..', '..');
const LESSON = 'phases/01-demo/01-serving';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gen-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('scripts/cheatsheets/prompt.md', fs.readFileSync(path.join(REPO, 'scripts/cheatsheets/prompt.md'), 'utf8'));
  write('cheatsheets/AUTHORING.md', fs.readFileSync(path.join(REPO, 'cheatsheets/AUTHORING.md'), 'utf8'));
  write(`${LESSON}/docs/en.md`, '# Serving\n\nStart the server with `serve --port 8000`. Call `run_job(spec)` to queue work.\n');
  write(`${LESSON}/code/main.py`, 'def run_job(spec):\n    return spec\n');
  write('cheatsheets/topics.yaml', `- id: demo-serving\n  title: Demo Serving\n  kind: commands\n  sources:\n    - ${LESSON}\n`);
  return root;
}

function poster(flag) {
  return `---
id: demo-serving
title: Demo Serving
subtitle: Start the demo server and queue a job.
hue: 120
sources: ${LESSON}
---

## Tasks
type: task-table
from: ${LESSON}/docs/en.md

| Task | Code |
|---|---|
| Start the server | \`serve ${flag} 8000\` |
| Queue a job | \`run_job(<spec>)\` |

## Tips
type: tips
from: ${LESSON}

- Start the server before you queue a job.
`;
}

const EVIDENCE = '# Evidence: cheatsheets/demo-serving.md\n\n## Tasks (task-table, 2)\n- serve --port: d:3\n- run_job: d:3\n\n## Tips (tips, 1)\n- start first: d:3\n';

function reply(topic, evidence = EVIDENCE) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: `<topic>\n${topic}\n</topic>\n<evidence>\n${evidence}</evidence>` }] };
}

function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(JSON.parse(JSON.stringify(params)));
          const next = replies.shift();
          return { finalMessage: async () => next };
        },
      },
    },
  };
}

function entry(root) {
  return topicMap.loadTopicMap(root).topics[0];
}

test('a reply that passes the check is written with a hash and a code', async () => {
  const root = fixture();
  const client = fakeClient([reply(poster('--port'))]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  const text = fs.readFileSync(path.join(root, 'cheatsheets/demo-serving.md'), 'utf8');
  assert.match(text, /^---\nid: demo-serving\ntitle: Demo Serving\ncode: DS\n/);
  assert.match(text, new RegExp(`source_hash: ${topicMap.sourceHash([LESSON], root)}`));
  assert.ok(fs.existsSync(path.join(root, 'cheatsheets/evidence/demo-serving.md')));
  const params = client.calls[0];
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.system[0].cache_control.type, 'ephemeral');
  assert.match(params.messages[0].content, /=== phases\/01-demo\/01-serving\/docs\/en\.md ===/);
});

test('check failures go back to the model and a fixed reply passes', async () => {
  const root = fixture();
  const client = fakeClient([reply(poster('--listen')), reply(poster('--port'))]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(client.calls.length, 2);
  const second = client.calls[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.match(second[2].content, /"--listen" is not in its from files/);
});

test('a topic that still fails after two retries is not written', async () => {
  const root = fixture();
  const bad = () => reply(poster('--listen'));
  const client = fakeClient([bad(), bad(), bad()]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, generate.MAX_RETRIES + 1);
  assert.equal(client.calls.length, 3);
  assert.ok(!fs.existsSync(path.join(root, 'cheatsheets/demo-serving.md')));
});

test('a reply without the two parts, a refusal and a foreign from path are reported', async () => {
  const root = fixture();
  const noTags = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the sheet.' }] };
  const foreign = reply(poster('--port').replace(`from: ${LESSON}\n`, 'from: phases/02-other\n'));
  const client = fakeClient([noTags, foreign, { stop_reason: 'refusal', content: [] }]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, false);
  assert.match(client.calls[1].messages[2].content, /one <topic> part and one <evidence> part/);
  assert.match(client.calls[2].messages[4].content, /phases\/02-other.*not a source of this topic|does not exist/);
  assert.deepEqual(result.problems, ['the model declined the request']);
});

test('main writes missing topics, takes --model opus and writes a summary', async () => {
  const root = fixture();
  const summary = path.join(root, 'summary.json');
  const client = fakeClient([reply(poster('--port'))]);
  const lines = [];
  const out = { log: line => lines.push(line), error: line => lines.push(line) };
  const code = await generate.main(['--missing', '--model', 'opus', '--summary', summary], { client, root, out });
  assert.equal(code, 0);
  assert.equal(client.calls[0].model, 'claude-opus-5-5');
  assert.deepEqual(JSON.parse(fs.readFileSync(summary, 'utf8')).written, ['demo-serving']);
  const status = JSON.parse((await capture(['--status'], root)).join('\n'));
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.stale, []);
  fs.appendFileSync(path.join(root, LESSON, 'docs/en.md'), '\nA new paragraph.\n');
  assert.deepEqual(JSON.parse((await capture(['--status'], root)).join('\n')).stale, ['demo-serving']);
});

test('main without a client or a key stops with code 2', async () => {
  const root = fixture();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(await generate.main(['--missing'], { root, out: { log() {}, error() {} } }), 2);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('an evidence file without a heading, a section or line references is sent back', async () => {
  const root = fixture();
  const client = fakeClient([reply(poster('--port'), '# Evidence\n\n## Tasks\n- no line here\n'), reply(poster('--port'))]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  const feedback = client.calls[1].messages[2].content;
  assert.match(feedback, /must start with "# Evidence: cheatsheets\/demo-serving\.md"/);
  assert.match(feedback, /no section for the block "Tips"/);
  assert.match(feedback, /section for "Tasks" gives no path:line/);
});

test('a from path that climbs out of the topic sources is refused', async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'phases/01-demo/02-other/docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'phases/01-demo/02-other/docs/en.md'), 'serve --listen 8000\n');
  const sneaky = poster('--listen').replace(`from: ${LESSON}/docs/en.md`, `from: ${LESSON}/../02-other/docs/en.md`);
  const client = fakeClient([reply(sneaky), reply(sneaky), reply(sneaky)]);
  const result = await generate.generateTopic({ entry: entry(root), client, root });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => /not a plain repository path|not a source of this topic/.test(problem)));
});

test('stamping refuses a sheet whose blocks cite a removed source', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'cheatsheets/demo-serving.md'), poster('--port'));
  const moved = { ...entry(root), sources: ['phases/01-demo/09-new'] };
  assert.throws(() => generate.stampTopic(moved, root), /not a source of this topic/);
  generate.stampTopic(entry(root), root);
  assert.match(fs.readFileSync(path.join(root, 'cheatsheets/demo-serving.md'), 'utf8'), /source_hash: [0-9a-f]{16}/);
});

test('codes avoid the codes that other sheets use', () => {
  const codes = generate.codeCandidates('Demo Serving');
  assert.equal(codes[0], 'DS');
  assert.ok(codes.includes('DE'));
});

async function capture(argv, root) {
  const lines = [];
  await generate.main(argv, { root, out: { log: line => lines.push(line), error: line => lines.push(line) } });
  return lines;
}
