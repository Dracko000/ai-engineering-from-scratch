'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const topicMap = require('./cheatsheet-topics');
const sheets = require('./build-cheatsheets');

const ROOT = path.resolve(__dirname, '..');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-map-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('the topic map parses and reports bad entries', () => {
  const good = topicMap.parseTopicMap('- id: demo\n  title: Demo\n  kind: concept\n  sources:\n    - phases/01-a/01-b\n');
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.topics[0].sources, ['phases/01-a/01-b']);
  const bad = topicMap.parseTopicMap('- id: Demo\n  title: Demo\n  kind: story\n  colour: red\n- id: Demo\n  title: Again\n  kind: concept\n  sources:\n    - x\n').errors.join('\n');
  assert.match(bad, /must be lower case/);
  assert.match(bad, /kind must be one of/);
  assert.match(bad, /unexpected line "colour: red"/);
  assert.match(bad, /appears twice/);
  assert.match(bad, /needs sources/);
});

test('every lesson, manual and project of the repository is in a topic', () => {
  const map = topicMap.loadTopicMap(ROOT);
  assert.deepEqual(map.errors, []);
  const problems = topicMap.mapProblems(map, sheets.loadTopics(ROOT), ROOT);
  assert.deepEqual(problems, []);
  const status = topicMap.mapStatus(map, sheets.loadTopics(ROOT), ROOT);
  assert.equal(status.coverage.lessons, status.coverage.lessonTotal);
  assert.equal(status.coverage.covered, status.coverage.total);
});

test('an uncovered lesson, a wrong source list and a stale hash are found', () => {
  const root = fixture({
    'phases/01-a/01-b/docs/en.md': '# B\n',
    'phases/01-a/02-c/docs/en.md': '# C\n',
    'projects/demo/project.json': '{}\n',
    'projects/_template/project.json': '{}\n',
    'cheatsheets/topics.yaml': '- id: demo\n  title: Demo\n  kind: concept\n  sources:\n    - phases/01-a/01-b\n',
  });
  const map = topicMap.loadTopicMap(root);
  const sheet = { id: 'demo', title: 'Demo', file: 'cheatsheets/demo.md', sources: ['phases/01-a/02-c'], sourceHash: 'old' };
  const problems = topicMap.mapProblems(map, [sheet], root).join('\n');
  assert.match(problems, /the lesson phases\/01-a\/02-c is in no topic/);
  assert.match(problems, /the project projects\/demo is in no topic/);
  assert.doesNotMatch(problems, /_template/);
  assert.match(problems, /sources must match/);
  assert.deepEqual(topicMap.mapStatus(map, [sheet], root).stale, ['demo']);
  assert.deepEqual(topicMap.mapStatus(map, [], root).missing, ['demo']);
});

test('the source hash covers docs/en.md and code, not translations or quizzes', () => {
  const root = fixture({
    'phases/01-a/01-b/docs/en.md': '# B\n',
    'phases/01-a/01-b/docs/es.md': '# B es\n',
    'phases/01-a/01-b/quiz.json': '{}\n',
    'phases/01-a/01-b/code/main.py': 'x = 1\n',
  });
  assert.deepEqual(topicMap.sourceFiles('phases/01-a/01-b', root), ['phases/01-a/01-b/code/main.py', 'phases/01-a/01-b/docs/en.md']);
  const before = topicMap.sourceHash(['phases/01-a/01-b'], root);
  fs.writeFileSync(path.join(root, 'phases/01-a/01-b/docs/es.md'), '# changed\n');
  assert.equal(topicMap.sourceHash(['phases/01-a/01-b'], root), before);
  fs.writeFileSync(path.join(root, 'phases/01-a/01-b/code/main.py'), 'x = 2\n');
  assert.notEqual(topicMap.sourceHash(['phases/01-a/01-b'], root), before);
});

test('every sheet records a source hash', () => {
  for (const topic of sheets.loadTopics(ROOT)) assert.match(topic.sourceHash, /^[0-9a-f]{16}$/, topic.file);
});
