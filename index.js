// Sets a commit status (default "Code owner approval") on a pull request's head commit.
//
// It passes when a code owner opened the PR, or when a code owner's latest review approves it and no
// code owner's latest review requests changes. This is GitHub's "require review from code owners",
// except that a code owner's own PR needs no second reviewer.
//
// It only runs from events that use the base or default branch's workflow with a write token
// (pull_request_target, workflow_run, workflow_dispatch, schedule), so a PR can't edit the workflow
// to pass itself.
//
// Owners are every user listed in CODEOWNERS; per-path ownership and teams are not resolved.

const SAFE_EVENTS = ['pull_request_target', 'workflow_run', 'workflow_dispatch', 'schedule'];
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** Lower-cased user handles in a CODEOWNERS file. Teams (@org/team) and emails are skipped. */
function parseCodeowners(text) {
	const owners = new Set();
	for (const raw of text.split('\n')) {
		const line = raw.replace(/#.*/, '').trim();
		if (!line) continue;
		for (const token of line.split(/\s+/).slice(1)) {
			if (token.startsWith('@') && !token.includes('/')) owners.add(token.slice(1).toLowerCase());
		}
	}
	return owners;
}

/** Each reviewer's latest review that counts. Comments don't change a reviewer's verdict. */
function latestVerdicts(reviews) {
	const verdicts = new Map();
	for (const r of [...reviews].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))) {
		if (!r.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
		verdicts.set(r.user.login.toLowerCase(), r.state);
	}
	return verdicts;
}

/** The status for a PR: { state: 'success' | 'failure', description }. */
function decide({ author, owners, reviews }) {
	if (owners.size === 0) return { state: 'failure', description: 'No users found in CODEOWNERS' };
	if (owners.has(author.toLowerCase())) return { state: 'success', description: `Opened by code owner @${author}` };

	const verdicts = latestVerdicts(reviews);
	const owned = [...owners].filter((o) => verdicts.has(o));
	const blocking = owned.find((o) => verdicts.get(o) === 'CHANGES_REQUESTED');
	if (blocking) return { state: 'failure', description: `@${blocking} requested changes` };
	const approver = owned.find((o) => verdicts.get(o) === 'APPROVED');
	if (approver) return { state: 'success', description: `Approved by code owner @${approver}` };
	return { state: 'failure', description: 'Waiting for a code owner to approve' };
}

async function readOwners(github, owner, repo) {
	for (const path of CODEOWNERS_PATHS) {
		try {
			const { data } = await github.rest.repos.getContent({ owner, repo, path });
			return parseCodeowners(Buffer.from(data.content, 'base64').toString('utf8'));
		} catch (e) {
			if (e.status !== 404) throw e;
		}
	}
	return new Set();
}

/** The open PRs this event is about. */
async function pullRequests(github, context) {
	const { owner, repo } = context.repo;
	const p = context.payload;
	if (p.pull_request) return [p.pull_request];
	if (p.workflow_run) {
		// A review on a fork PR: the run's pull_requests list is empty for forks, so look it up by head
		const run = p.workflow_run;
		if (!run.head_repository) return []; // the fork was deleted
		const { data } = await github.rest.pulls.list({ owner, repo, state: 'open', head: `${run.head_repository.owner.login}:${run.head_branch}` });
		return data.filter((pr) => pr.head.sha === run.head_sha);
	}
	return github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
}

async function run({ github, context, core, statusContext = 'Code owner approval' }) {
	if (!SAFE_EVENTS.includes(context.eventName)) {
		core.setFailed(`Run this on ${SAFE_EVENTS.join(', ')}, not ${context.eventName}: on that event a pull request runs its own copy of the workflow and could pass itself. See the README for the review relay.`);
		return;
	}
	const { owner, repo } = context.repo;
	const owners = await readOwners(github, owner, repo);
	const target_url = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
	for (const pr of await pullRequests(github, context)) {
		const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
		const { state, description } = decide({ author: pr.user.login, owners, reviews });
		core.info(`#${pr.number} ${pr.head.sha.slice(0, 7)}: ${state}, ${description}`);
		await github.rest.repos.createCommitStatus({ owner, repo, sha: pr.head.sha, state, context: statusContext, description, target_url });
	}
}

module.exports = { run, decide, parseCodeowners, latestVerdicts, SAFE_EVENTS };
