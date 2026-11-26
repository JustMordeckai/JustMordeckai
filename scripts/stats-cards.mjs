// Generates the "commits per hour" (Europe/Paris) and "top languages" SVG cards over the last
// 12 months, reading the commits of every repo the token can access, private ones included.
// GitHub's contribution data does not detail private contributions, hence this script.
import {mkdirSync, writeFileSync} from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const LOGIN = process.env.USERNAME;
const TZ = 'Europe/Paris';
const OUT_DIR = 'stats';
const TOP_LANGUAGES = 6;

if (!TOKEN || !LOGIN) {
    console.error('GITHUB_TOKEN and USERNAME are required');
    process.exit(1);
}

const HEADERS = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
};

async function api(path) {
    const res = await fetch(`https://api.github.com${path}`, {headers: HEADERS});
    // 409 = empty repo
    if (res.status === 409) return {data: [], next: null};
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
    const next = /<https:\/\/api\.github\.com([^>]+)>; rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    return {data: await res.json(), next};
}

async function paginate(path) {
    const items = [];
    for (let next = path; next; ) {
        const page = await api(next);
        items.push(...page.data);
        next = page.next;
    }
    return items;
}

async function graphql(query, variables) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {...HEADERS, 'Content-Type': 'application/json'},
        body: JSON.stringify({query, variables})
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on GraphQL`);
    const body = await res.json();
    if (body.errors) throw new Error(`GraphQL: ${body.errors.map(e => e.message).join('; ')}`);
    return body.data;
}

const LANGUAGES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    languages(first: 100) { edges { size node { name color } } }
  }
}`;

// Each repo spreads its commits over its languages, pro rata of their size in bytes.
const languageWeights = new Map();
async function addLanguages(repo, commits) {
    const data = await graphql(LANGUAGES_QUERY, {owner: repo.owner.login, name: repo.name});
    const edges = data.repository?.languages.edges ?? [];
    const size = edges.reduce((sum, e) => sum + e.size, 0);
    for (const {size: bytes, node} of edges) {
        const entry = languageWeights.get(node.name) ?? {weight: 0, color: node.color};
        entry.weight += (commits * bytes) / size;
        languageWeights.set(node.name, entry);
    }
}

const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
const repos = await paginate('/user/repos?affiliation=owner,collaborator&per_page=100');

// Forks share SHAs with their upstream repo: each commit is counted once.
const commitDates = new Map();
for (const repo of repos) {
    const commits = await paginate(
        `/repos/${repo.full_name}/commits?author=${encodeURIComponent(LOGIN)}&since=${since}&per_page=100`
    );
    let fresh = 0;
    for (const c of commits) {
        if (commitDates.has(c.sha)) continue;
        commitDates.set(c.sha, c.commit.author.date);
        fresh++;
    }
    if (fresh) await addLanguages(repo, fresh);
    // Actions logs of a public repo are public: private repo names stay out of them.
    console.log(`${repo.private ? '(private repo)' : repo.full_name}: ${commits.length}`);
}

const hourOf = new Intl.DateTimeFormat('en-GB', {timeZone: TZ, hour: '2-digit', hourCycle: 'h23'});
const hours = Array(24).fill(0);
for (const date of commitDates.values()) hours[Number(hourOf.format(new Date(date)))]++;
const total = commitDates.size;
console.log(`Total: ${total} commits`, hours);

const ranked = [...languageWeights].map(([name, l]) => ({name, ...l})).sort((a, b) => b.weight - a.weight);
const weightSum = ranked.reduce((sum, l) => sum + l.weight, 0) || 1;
const languages = ranked.slice(0, TOP_LANGUAGES).map(l => ({name: l.name, color: l.color, share: l.weight / weightSum}));
const otherShare = ranked.slice(TOP_LANGUAGES).reduce((sum, l) => sum + l.weight, 0) / weightSum;
if (otherShare > 0) languages.push({name: 'Other', color: null, share: otherShare});
console.log('Languages:', languages.map(l => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', '));

const THEMES = {
    light: {bg: '#ffffff', border: '#e4e2e2', title: '#0366d6', text: '#586069', bar: '#40c463', other: '#c6cbd1'},
    dark: {bg: '#0d1117', border: '#2e343b', title: '#0366d6', text: '#77909c', bar: '#40c463', other: '#484f58'}
};

const STYLE = `<style>* { font-family: 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif }</style>`;
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const percent = share => `${(share * 100).toFixed(1)}%`;

function renderHours(t) {
    const W = 340, H = 200;
    const chart = {x: 35, y: 60, w: 280, h: 100};
    const max = Math.max(1, ...hours);
    const step = chart.w / 24;
    const bars = hours
        .map((n, h) => {
            const bh = (n / max) * chart.h;
            const x = chart.x + h * step + 1;
            const y = chart.y + chart.h - bh;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${t.bar}"><title>${String(h).padStart(2, '0')}h: ${n} commits</title></rect>`;
        })
        .join('');
    const ticks = [0, 6, 12, 18, 23]
        .map(h => `<text x="${(chart.x + h * step + step / 2).toFixed(1)}" y="${chart.y + chart.h + 16}" text-anchor="middle">${h}h</text>`)
        .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${STYLE}
<rect x="1" y="1" rx="5" ry="5" width="${W - 2}" height="${H - 2}" fill="${t.bg}" stroke="${t.border}"/>
<text x="30" y="36" font-size="20" fill="${t.title}">Commits per hour</text>
<text x="30" y="52" font-size="11" fill="${t.text}">${total} commits · last 12 months · ${TZ}</text>
${bars}
<line x1="${chart.x}" y1="${chart.y + chart.h + 0.5}" x2="${chart.x + chart.w}" y2="${chart.y + chart.h + 0.5}" stroke="${t.text}"/>
<g font-size="10" fill="${t.text}">${ticks}</g>
</svg>
`;
}

// Same width and title size as the profile-details card, shown right under it.
function renderLanguages(t) {
    const W = 700, x0 = 30, barY = 66, barW = W - 2 * x0, cols = 4;
    const H = 104 + Math.ceil(languages.length / cols) * 24;
    let x = x0;
    const segments = languages
        .map(l => {
            const w = l.share * barW;
            const rect = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="10" fill="${l.color ?? t.other}"><title>${escape(l.name)}: ${percent(l.share)}</title></rect>`;
            x += w;
            return rect;
        })
        .join('');
    const legend = languages
        .map((l, i) => {
            const lx = x0 + (i % cols) * (barW / cols);
            const ly = barY + 40 + Math.floor(i / cols) * 24;
            return `<circle cx="${(lx + 5).toFixed(1)}" cy="${ly - 5}" r="5" fill="${l.color ?? t.other}"/><text x="${(lx + 16).toFixed(1)}" y="${ly}">${escape(l.name)} <tspan opacity="0.75">${percent(l.share)}</tspan></text>`;
        })
        .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${STYLE}
<rect x="1" y="1" rx="5" ry="5" width="${W - 2}" height="${H - 2}" fill="${t.bg}" stroke="${t.border}"/>
<text x="30" y="38" font-size="22" fill="${t.title}">Top languages</text>
<text x="${W - 30}" y="38" font-size="12" fill="${t.text}" text-anchor="end">${total} commits · last 12 months · split by repo languages</text>
<clipPath id="bar"><rect x="${x0}" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${segments}</g>
<g font-size="14" fill="${t.text}">${legend}</g>
</svg>
`;
}

mkdirSync(OUT_DIR, {recursive: true});
for (const [name, theme] of Object.entries(THEMES)) {
    writeFileSync(`${OUT_DIR}/commit-hours-${name}.svg`, renderHours(theme));
    writeFileSync(`${OUT_DIR}/top-languages-${name}.svg`, renderLanguages(theme));
}
