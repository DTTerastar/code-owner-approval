// node --test
const test = require('node:test');
const assert = require('node:assert');
const { decide, parseCodeowners } = require('./index.js');

const owners = parseCodeowners('# comment\n* @DTTerastar @org/team someone@example.com\n/docs/ @Helper # inline\n');
const review = (login, state, minute) => ({ user: { login }, state, submitted_at: `2026-11-04T10:${String(minute).padStart(2, '0')}:00Z` });

test('parses user owners, skipping teams, emails and comments', () => {
	assert.deepStrictEqual([...owners].sort(), ['dtterastar', 'helper']);
});

test("a code owner's own PR passes with no review", () => {
	assert.strictEqual(decide({ author: 'DTTerastar', owners, reviews: [] }).state, 'success');
});

test("anyone else's PR waits for a code owner", () => {
	const d = decide({ author: 'contributor', owners, reviews: [review('someone-else', 'APPROVED', 1)] });
	assert.deepStrictEqual(d, { state: 'failure', description: 'Waiting for a code owner to approve' });
});

test('a code owner approval passes; a later comment keeps it', () => {
	const reviews = [review('dtterastar', 'APPROVED', 1), review('DTTerastar', 'COMMENTED', 2)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews }).state, 'success');
});

test('the latest verdict wins: changes requested after approval blocks, dismissal clears', () => {
	const approvedThenBlocked = [review('DTTerastar', 'APPROVED', 1), review('DTTerastar', 'CHANGES_REQUESTED', 2)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews: approvedThenBlocked }).state, 'failure');
	const blockedThenApproved = [...approvedThenBlocked, review('DTTerastar', 'APPROVED', 3)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews: blockedThenApproved }).state, 'success');
	const dismissed = [review('DTTerastar', 'APPROVED', 1), review('DTTerastar', 'DISMISSED', 2)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews: dismissed }).state, 'failure');
});

test('one owner requesting changes blocks another owner approving', () => {
	const reviews = [review('DTTerastar', 'APPROVED', 1), review('helper', 'CHANGES_REQUESTED', 2)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews }).description, '@helper requested changes');
});

test('reviews arrive out of order', () => {
	const reviews = [review('DTTerastar', 'APPROVED', 5), review('DTTerastar', 'CHANGES_REQUESTED', 2)];
	assert.strictEqual(decide({ author: 'contributor', owners, reviews }).state, 'success');
});

test('an empty CODEOWNERS fails closed', () => {
	assert.strictEqual(decide({ author: 'DTTerastar', owners: new Set(), reviews: [] }).state, 'failure');
});

test('refuses events where a pull request runs its own workflow', async () => {
	const { run } = require('./index.js');
	let failed = '';
	let called = false;
	const github = { rest: { repos: { getContent: async () => (called = true) } } };
	await run({ github, context: { eventName: 'pull_request', repo: { owner: 'o', repo: 'r' }, payload: {} }, core: { setFailed: (m) => (failed = m) } });
	assert.match(failed, /not pull_request/);
	assert.strictEqual(called, false);
});

test('sets the status on each open PR it is run for', async () => {
	const { run } = require('./index.js');
	const statuses = [];
	const github = {
		paginate: async (fn, args) => fn(args),
		rest: {
			repos: {
				getContent: async () => ({ data: { content: Buffer.from('* @owner').toString('base64') } }),
				createCommitStatus: async (s) => statuses.push(s)
			},
			pulls: { listReviews: async () => [] }
		}
	};
	const context = { eventName: 'pull_request_target', repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1, payload: { pull_request: { number: 7, user: { login: 'Owner' }, head: { sha: 'abc1234def' } } } };
	await run({ github, context, core: { info() {} }, statusContext: 'Mine' });
	assert.deepStrictEqual(statuses.map((s) => [s.sha, s.state, s.context]), [['abc1234def', 'success', 'Mine']]);
});
