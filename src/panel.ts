// .climb/panel.html: the climb at a glance, one self-contained page rewritten after every
// decision. Goal tree with progress, each metric's path from baseline toward target, every
// experiment with what it measured against its noise, recorded knowledge, and where the time went.
import type { Row, build } from "./export";
import { type Goal, type Metric, type State, met, parts } from "./ledger";
import { goalPct, progressPct } from "./logic";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));

/** A small line chart of a metric's measured values, with the target as a dashed line. */
function spark(vs: number[], target: number | undefined, dir: "up" | "down"): string {
	if (vs.length < 2) return "";
	const w = 160;
	const h = 36;
	const all = target !== undefined && Number.isFinite(target) ? [...vs, target] : vs;
	const lo = Math.min(...all);
	const hi = Math.max(...all);
	const y = (v: number) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 6));
	const x = (i: number) => (i / (vs.length - 1)) * (w - 4) + 2;
	const line = vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
	const better = dir === "down" ? vs[vs.length - 1] <= vs[0] : vs[vs.length - 1] >= vs[0];
	const goal = target !== undefined && Number.isFinite(target) ? `<line x1="0" x2="${w}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}" class="target"/>` : "";
	return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="trend">${goal}<polyline points="${line}" class="${better ? "up" : "down"}"/></svg>`;
}

function metricRow(g: Goal, m: Metric): string {
	const best = g.best[m.name];
	const pct = m.hold ? undefined : progressPct(m, best);
	const series = (g.series.get(m.name) ?? []).map(p => p.v);
	const bar = pct === undefined ? `<span class="pill">hold</span>` : `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div><span class="pct">${pct}%</span>`;
	return `<tr><td>${met(m, best) ? "✓" : ""} <b>${esc(m.name)}</b>${m.unit ? ` <span class="dim">${esc(m.unit)}</span>` : ""}</td><td>${num(m.baseline)} → <b>${num(best)}</b>${m.hold ? "" : ` / ${num(m.target)}`}</td><td>${bar}</td><td class="dim">±${(m.noise * 100).toFixed(1)}%</td><td>${spark(series, m.hold ? undefined : m.target, m.dir)}</td></tr>`;
}

function goalBlock(st: State, g: Goal, depth: number): string {
	const kids = parts(st, g);
	const state = g.done ? `done: ${g.done.result}` : g.stallPending ? "stalled, judge pending" : kids.some(k => !k.done) ? `split into ${kids.length} parts` : g.open ? `${g.open.id} open: ${g.open.lever}` : g.card ? "climbing" : "researching";
	const history = g.card && kids.some(k => !k.done) ? `<p class="dim">Scorecard before the split: history; the parts below carry the climb.</p>` : "";
	const card = g.card
		? `${history}<table class="metrics"><thead><tr><th>metric</th><th>baseline → best / target</th><th>progress</th><th>noise</th><th>trend</th></tr></thead><tbody>${g.card.metrics.map(m => metricRow(g, m)).join("")}</tbody></table>`
		: g.probes.length
			? `<p class="dim">research: ${g.probes.length} probes; latest ${g.probes.slice(-3).map(p => `${esc(p.name)} = ${num(p.value)}`).join(", ")}</p>`
			: "";
	const learned = g.learned.length ? `<ul class="learned">${g.learned.slice(-6).map(l => `<li><span class="pill ${l.type}">${l.type}</span> ${esc(l.text)}</li>`).join("")}</ul>` : "";
	return `<section class="goal" style="margin-left:${depth * 18}px"><h${depth ? 3 : 2}>${esc(g.id)} <span class="pill">${esc(state)}</span> <span class="pct">${goalPct(st, g)}%</span></h${depth ? 3 : 2}><p class="intent">${esc(g.intent)}</p>${card}${learned}</section>${kids.map(k => goalBlock(st, k, depth + 1)).join("")}`;
}

function experiments(rows: Row[]): string {
	const multi = new Set(rows.map(r => r.group)).size > 1;
	const byRecord = new Map<string, Row[]>();
	for (const r of rows) byRecord.set(r.record_id, [...(byRecord.get(r.record_id) ?? []), r]);
	const recs = [...byRecord.values()].sort((a, b) => b[0].decided_at.localeCompare(a[0].decided_at));
	const body = recs
		.map(rs => {
			const r = rs[0];
			const abandoned = r.reason.startsWith("abandoned:");
			const verdict = abandoned ? "abandoned" : r.qualification.by_proof ? "kept by proof" : r.verdict;
			const moves = rs
				.filter(x => x.after !== undefined && x.before !== undefined)
				.map(x => `<span class="${x.qualification.statistical_win ? "win" : Math.abs(x.change_percent) / 100 > x.noise ? "loss" : "dim"}">${esc(x.metric_id)} ${num(x.before)}→${num(x.after)} (${x.change_percent >= 0 ? "+" : ""}${x.change_percent.toFixed(0)}%, ±${(x.noise * 100).toFixed(0)}%)</span>`)
				.join("<br>");
			return `<tr class="${verdict.replace(/ /g, "-")}"><td title="${esc(r.record_id)}">${esc(multi ? r.record_id : r.record_id.split("/").pop())}</td><td>${esc(r.decided_at.slice(5, 16).replace("T", " "))}</td><td>${esc(r.scope)}</td><td><span class="pill">${esc(verdict)}</span></td><td>${moves || "—"}</td><td class="dim">${esc(r.correctness.gate)}</td><td class="reason">${esc(r.reason.slice(0, 220))}</td></tr>`;
		})
		.join("");
	return `<table class="exps"><thead><tr><th>experiment</th><th>decided</th><th>lever</th><th>verdict</th><th>measured (change, noise)</th><th>guard</th><th>reason</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function render(st: State, data: ReturnType<typeof build>, efficiency: string): string {
	const roots = [...st.goals.values()].filter(g => !g.parent);
	const rows = data.metric_rows;
	const kept = new Set(rows.filter(r => r.verdict === "kept").map(r => r.record_id)).size;
	const total = new Set(rows.map(r => r.record_id)).size;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>climb · ${esc(data.repo.name)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--card:#fff;--win:#15803d;--loss:#b91c1c;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--dim:#a8a29e;--line:#292524;--card:#1c1917;--win:#4ade80;--loss:#f87171;--accent:#60a5fa}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:17px}h3{font-size:15px}h2,h3{margin:0 0 4px}
.dim{color:var(--dim)}.intent{color:var(--dim);margin:0 0 8px;max-width:900px}
.goal{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--dim);font-size:12px}
.bar{display:inline-block;width:110px;height:8px;background:var(--line);border-radius:4px;overflow:hidden;vertical-align:middle}.bar span{display:block;height:100%;background:var(--accent)}
.pct{font-variant-numeric:tabular-nums;margin-left:6px}.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;border:1px solid var(--line);color:var(--dim)}
.pill.trap{color:var(--loss)}.pill.dead-end{color:var(--dim)}.pill.fact{color:var(--accent)}
.spark polyline{fill:none;stroke-width:2}.spark .up{stroke:var(--win)}.spark .down{stroke:var(--loss)}.spark .target{stroke:var(--dim);stroke-dasharray:3 3}
.win{color:var(--win)}.loss{color:var(--loss)}.reason{color:var(--dim);font-size:12px;max-width:420px}td:first-child{white-space:nowrap}
tr.kept td:first-child,tr.kept-by-proof td:first-child{border-left:3px solid var(--win)}tr.dropped td:first-child{border-left:3px solid var(--loss)}tr.abandoned td:first-child{border-left:3px solid var(--line)}
pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px}
.scroll{overflow-x:auto}
</style></head><body><main>
<h1>climb · ${esc(data.repo.name)}</h1>
<p class="dim">${total} experiments decided, ${kept} kept · updated ${esc(data.generated_at.slice(0, 16).replace("T", " "))} UTC · evidence: .climb/export.json (${esc(data.schema)})</p>
${roots.map(g => goalBlock(st, g, 0)).join("")}
<h2 style="margin-top:20px">Experiments</h2><div class="scroll">${experiments(rows)}</div>
<h2 style="margin-top:20px">Where the time went</h2><pre>${esc(efficiency)}</pre>
</main></body></html>`;
}
