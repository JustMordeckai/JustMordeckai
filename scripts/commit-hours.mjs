// Génère une carte SVG "commits par heure" (Europe/Paris) sur les 12 derniers mois,
// en lisant directement les commits de tous les repos accessibles au token, privés inclus.
// L'API GraphQL de GitHub n'expose pas le détail des contributions privées, d'où ce script.
import {mkdirSync, writeFileSync} from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const LOGIN = process.env.USERNAME;
const TZ = 'Europe/Paris';
const OUT_DIR = 'stats';

if (!TOKEN || !LOGIN) {
    console.error('GITHUB_TOKEN and USERNAME are required');
    process.exit(1);
}

async function api(path) {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    // 409 = repo vide
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

const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
const repos = await paginate('/user/repos?affiliation=owner,collaborator&per_page=100');

// Les forks partagent des SHA avec leur repo d'origine : on dédoublonne.
const commitDates = new Map();
for (const repo of repos) {
    const commits = await paginate(
        `/repos/${repo.full_name}/commits?author=${encodeURIComponent(LOGIN)}&since=${since}&per_page=100`
    );
    for (const c of commits) commitDates.set(c.sha, c.commit.author.date);
    console.log(`${repo.full_name}: ${commits.length}`);
}

const hourOf = new Intl.DateTimeFormat('en-GB', {timeZone: TZ, hour: '2-digit', hourCycle: 'h23'});
const hours = Array(24).fill(0);
for (const date of commitDates.values()) hours[Number(hourOf.format(new Date(date)))]++;
const total = commitDates.size;
console.log(`Total: ${total} commits`, hours);

const THEMES = {
    light: {bg: '#ffffff', border: '#e4e2e2', title: '#0366d6', text: '#586069', bar: '#40c463'},
    dark: {bg: '#0d1117', border: '#2e343b', title: '#0366d6', text: '#77909c', bar: '#40c463'}
};

function render(t) {
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
<style>* { font-family: 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif }</style>
<rect x="1" y="1" rx="5" ry="5" width="${W - 2}" height="${H - 2}" fill="${t.bg}" stroke="${t.border}"/>
<text x="30" y="36" font-size="20" fill="${t.title}">Commits per hour</text>
<text x="30" y="52" font-size="11" fill="${t.text}">${total} commits · last 12 months · ${TZ}</text>
${bars}
<line x1="${chart.x}" y1="${chart.y + chart.h + 0.5}" x2="${chart.x + chart.w}" y2="${chart.y + chart.h + 0.5}" stroke="${t.text}"/>
<g font-size="10" fill="${t.text}">${ticks}</g>
</svg>
`;
}

mkdirSync(OUT_DIR, {recursive: true});
for (const [name, theme] of Object.entries(THEMES)) {
    writeFileSync(`${OUT_DIR}/commit-hours-${name}.svg`, render(theme));
}
