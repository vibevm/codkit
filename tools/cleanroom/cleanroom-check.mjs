#!/usr/bin/env node
// cleanroom-check — проверка документов patchset на заимствования из референсов.
//
// Что делает:
//   A. Инвентарь код-блоков в <reports>/**/*.md (файл, строка, язык, размер).
//      В документах код-блоки допустимы только для НАШИХ схем и псевдокода.
//   B. Для каждой строки внутри код-блока длиннее --min-len символов ищет её как fixed string
//      в референсных репозиториях (одним проходом grep -F по списку паттернов) и печатает
//      совпадения. Любое совпадение — потенциальное копирование.
//   C. Ищет в отчётах продуктовые идентификаторы референсов из cleanroom-terms.txt и печатает
//      контексты употребления, чтобы человек убедился: это упоминание-факт, а не заимствование.
//
// Запуск (из корня patchset):
//   node tools/cleanroom/cleanroom-check.mjs --reports vibevm/vibespecs
//   node tools/cleanroom/cleanroom-check.mjs --section b --repo brave-core
//   node tools/cleanroom/cleanroom-check.mjs --min-len 20 --json out.json
//
// Код возврата: 0 — чисто; 1 — есть совпадения в секции B; 2 — ошибка запуска.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHSET_ROOT = path.resolve(HERE, '..', '..');

const DEFAULT_REPO_NAMES = [
	'brave-core',
	'positron',
	'gitlab-web-ide-vscode-fork',
	'gitlab-web-ide',
];

function parseArgs(argv) {
	const opts = {
		minLen: 25,
		reportsDir: path.join(PATCHSET_ROOT, 'vibevm', 'vibespecs'),
		termsFile: path.join(HERE, 'cleanroom-terms.txt'),
		repos: null,           // null => DEFAULT_REPO_NAMES рядом с корнем patchset
		sections: 'abc',
		json: null,
		contextChars: 160,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) { fail(`флаг ${a} требует значения`); }
			return v;
		};
		switch (a) {
			case '--min-len': opts.minLen = Number.parseInt(next(), 10); break;
			case '--reports': opts.reportsDir = path.resolve(next()); break;
			case '--terms': opts.termsFile = path.resolve(next()); break;
			case '--repo': (opts.repos ??= []).push(path.resolve(next())); break;
			case '--section': opts.sections = next().toLowerCase(); break;
			case '--json': opts.json = path.resolve(next()); break;
			case '--context': opts.contextChars = Number.parseInt(next(), 10); break;
			case '--quiet': opts.quiet = true; break;
			case '-h':
			case '--help': printHelp(); process.exit(0); break;
			default: fail(`неизвестный флаг: ${a}`);
		}
	}
	if (!Number.isFinite(opts.minLen) || opts.minLen < 1) { fail('--min-len должен быть положительным числом'); }
	return opts;
}

function printHelp() {
	process.stdout.write([
		'cleanroom-check — проверка отчётов codkit на заимствования из референсов',
		'',
		'  --min-len N     минимальная длина строки код-блока для поиска (по умолчанию 25)',
		'  --reports DIR   каталог отчётов (по умолчанию docs/codkit/research)',
		'  --terms FILE    список продуктовых идентификаторов (по умолчанию docs/codkit/tools/cleanroom-terms.txt)',
		'  --repo DIR      референсный репозиторий (можно повторять; по умолчанию четыре стандартных)',
		'  --section abc   какие секции выполнять: a — инвентарь, b — поиск строк, c — термины',
		'  --json FILE     дополнительно выгрузить результат машинно-читаемо',
		'  --context N     сколько символов строки печатать в секции C (по умолчанию 160)',
		'  --quiet         печатать только проблемы',
		'',
	].join('\n'));
}

function fail(msg) {
	process.stderr.write(`cleanroom-check: ${msg}\n`);
	process.exit(2);
}

function resolveRepos(opts) {
	if (opts.repos) { return opts.repos.filter(dirExists); }
	const parent = path.dirname(PATCHSET_ROOT);
	return DEFAULT_REPO_NAMES.map(n => path.join(parent, n)).filter(dirExists);
}

function dirExists(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listMarkdown(dir) {
	const out = [];
	const walk = (d) => {
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) {
				if (e.name === '.git' || e.name === 'node_modules') { continue; }
				walk(p);
			} else if (e.isFile() && e.name.endsWith('.md')) {
				out.push(p);
			}
		}
	};
	walk(dir);
	return out;
}

// --- Секция A: инвентарь код-блоков -------------------------------------------------

// Возвращает [{ file, startLine, endLine, lang, lines: [{ n, text }] }]
function collectCodeBlocks(files) {
	const blocks = [];
	const fence = /^(\s*)(`{3,}|~{3,})(.*)$/;
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		const lines = text.split('\n');
		let open = null;
		for (let i = 0; i < lines.length; i++) {
			const m = fence.exec(lines[i]);
			if (!m) {
				if (open) { open.lines.push({ n: i + 1, text: lines[i] }); }
				continue;
			}
			const marker = m[2];
			const info = m[3].trim();
			if (!open) {
				open = { file, startLine: i + 1, endLine: -1, lang: info || '(без языка)', marker: marker[0], markerLen: marker.length, lines: [] };
			} else if (marker[0] === open.marker && marker.length >= open.markerLen && info === '') {
				open.endLine = i + 1;
				blocks.push(open);
				open = null;
			} else {
				open.lines.push({ n: i + 1, text: lines[i] });
			}
		}
		if (open) { open.endLine = lines.length; blocks.push(open); } // незакрытый блок — тоже блок
	}
	return blocks;
}

function reportBlocks(blocks, opts) {
	if (opts.quiet) { return; }
	section('A. Инвентарь код-блоков в отчётах');
	if (blocks.length === 0) { console.log('  код-блоков нет'); return; }
	let prevFile = null;
	for (const b of blocks) {
		if (b.file !== prevFile) { console.log(`\n  ${rel(b.file)}`); prevFile = b.file; }
		console.log(`    строки ${b.startLine}–${b.endLine}  язык: ${b.lang}  строк внутри: ${b.lines.length}`);
	}
	console.log(`\n  всего блоков: ${blocks.length} в ${new Set(blocks.map(b => b.file)).size} файлах`);
}

// --- Секция B: поиск строк код-блоков в референсах ----------------------------------

function collectCandidates(blocks, minLen) {
	// candidate -> [{ file, line, block }]
	const map = new Map();
	for (const b of blocks) {
		for (const l of b.lines) {
			const t = l.text.trim();
			if (t.length <= minLen) { continue; }
			if (!map.has(t)) { map.set(t, []); }
			map.get(t).push({ file: b.file, line: l.n });
		}
	}
	return map;
}

function grepRepo(repoDir, patternsFile) {
	// Один проход grep -F по всем паттернам сразу (Aho-Corasick), бинарники пропускаем.
	const args = [
		'-r', '-I', '-F', '-o', '-n',
		'--exclude-dir=.git',
		'--exclude-dir=node_modules',
		'-f', patternsFile,
		'.',
	];
	const res = spawnSync('grep', args, {
		cwd: repoDir,
		encoding: 'utf8',
		maxBuffer: 512 * 1024 * 1024,
	});
	if (res.error) { fail(`не удалось запустить grep: ${res.error.message}`); }
	// grep: 0 — есть совпадения, 1 — нет, >1 — ошибка (но частичные ошибки доступа не фатальны)
	if (res.status !== 0 && res.status !== 1 && !res.stdout) {
		process.stderr.write(`  предупреждение: grep в ${rel(repoDir)} завершился с кодом ${res.status}\n`);
	}
	const hits = [];
	for (const line of (res.stdout || '').split('\n')) {
		if (!line) { continue; }
		const first = line.indexOf(':');
		if (first < 0) { continue; }
		const second = line.indexOf(':', first + 1);
		if (second < 0) { continue; }
		hits.push({
			path: line.slice(0, first),
			line: Number.parseInt(line.slice(first + 1, second), 10),
			text: line.slice(second + 1),
		});
	}
	return hits;
}

function runSectionB(blocks, repos, opts) {
	section('B. Поиск строк код-блоков в референсных репозиториях');
	const candidates = collectCandidates(blocks, opts.minLen);
	console.log(`  строк-кандидатов (длиннее ${opts.minLen} символов): ${candidates.size}`);
	if (candidates.size === 0) { return []; }
	if (repos.length === 0) {
		console.log('  предупреждение: ни один референсный репозиторий не найден — поиск пропущен');
		return [];
	}
	const tmp = path.join(process.env.TMPDIR || '/tmp', `cleanroom-patterns-${process.pid}.txt`);
	fs.writeFileSync(tmp, [...candidates.keys()].join('\n') + '\n', 'utf8');
	const findings = [];
	try {
		for (const repo of repos) {
			const t0 = Date.now();
			const hits = grepRepo(repo, tmp);
			const secs = ((Date.now() - t0) / 1000).toFixed(1);
			console.log(`\n  ${rel(repo)}: совпадений ${hits.length} (${secs} с)`);
			// группируем по тексту совпадения
			const byText = new Map();
			for (const h of hits) {
				if (!byText.has(h.text)) { byText.set(h.text, []); }
				byText.get(h.text).push(h);
			}
			for (const [text, hs] of byText) {
				const origins = candidates.get(text) || [];
				console.log(`    СОВПАДЕНИЕ: ${truncate(text, 120)}`);
				for (const o of origins) { console.log(`      в отчёте: ${rel(o.file)}:${o.line}`); }
				for (const h of hs.slice(0, 5)) { console.log(`      в референсе: ${path.basename(repo)}/${h.path.replace(/^\.\//, '')}:${h.line}`); }
				if (hs.length > 5) { console.log(`      …и ещё ${hs.length - 5} мест в референсе`); }
				findings.push({ text, repo: rel(repo), origins: origins.map(o => `${rel(o.file)}:${o.line}`), hits: hs.length });
			}
		}
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* не важно */ }
	}
	console.log(`\n  итого проблемных строк: ${findings.length}`);
	return findings;
}

// --- Секция C: продуктовые идентификаторы референсов --------------------------------

function loadTerms(file) {
	if (!fs.existsSync(file)) { return []; }
	return fs.readFileSync(file, 'utf8')
		.split('\n')
		.map(l => l.replace(/#.*$/, '').trim())
		.filter(Boolean);
}

function runSectionC(files, opts) {
	section('C. Употребление продуктовых идентификаторов референсов');
	const terms = loadTerms(opts.termsFile);
	if (terms.length === 0) {
		console.log(`  список терминов пуст или отсутствует: ${rel(opts.termsFile)}`);
		return [];
	}
	console.log(`  терминов в списке: ${terms.length}`);
	const lowered = terms.map(t => ({ term: t, lc: t.toLowerCase() }));
	const results = [];
	for (const file of files) {
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		for (let i = 0; i < lines.length; i++) {
			const lc = lines[i].toLowerCase();
			for (const { term, lc: needle } of lowered) {
				if (lc.includes(needle)) {
					results.push({ term, file: rel(file), line: i + 1, text: truncate(lines[i].trim(), opts.contextChars) });
				}
			}
		}
	}
	const byTerm = new Map();
	for (const r of results) {
		if (!byTerm.has(r.term)) { byTerm.set(r.term, []); }
		byTerm.get(r.term).push(r);
	}
	for (const { term } of lowered) {
		const rs = byTerm.get(term) || [];
		if (rs.length === 0) { if (!opts.quiet) { console.log(`\n  «${term}»: не встречается`); } continue; }
		console.log(`\n  «${term}»: ${rs.length} употреблений`);
		for (const r of rs) { console.log(`    ${r.file}:${r.line}  ${r.text}`); }
	}
	console.log(`\n  итого употреблений: ${results.length} (проверяются человеком: упоминание-факт, а не заимствование)`);
	return results;
}

// --- утилиты ------------------------------------------------------------------------

function section(title) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function rel(p) {
	const r = path.relative(PATCHSET_ROOT, p);
	return r.startsWith('..') ? p : r;
}

function truncate(s, n) {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// --- main ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (!dirExists(opts.reportsDir)) { fail(`каталог отчётов не найден: ${opts.reportsDir}`); }
const files = listMarkdown(opts.reportsDir);
const repos = resolveRepos(opts);

console.log(`cleanroom-check`);
console.log(`  отчёты:     ${rel(opts.reportsDir)} (${files.length} файлов .md)`);
console.log(`  референсы:  ${repos.length ? repos.map(rel).join(', ') : '(не найдены)'}`);
console.log(`  секции:     ${opts.sections}`);

const blocks = collectCodeBlocks(files);
if (opts.sections.includes('a')) { reportBlocks(blocks, opts); }
const bFindings = opts.sections.includes('b') ? runSectionB(blocks, repos, opts) : [];
const cFindings = opts.sections.includes('c') ? runSectionC(files, opts) : [];

if (opts.json) {
	fs.writeFileSync(opts.json, JSON.stringify({
		reportsDir: rel(opts.reportsDir),
		repos: repos.map(rel),
		minLen: opts.minLen,
		blocks: blocks.map(b => ({ file: rel(b.file), startLine: b.startLine, endLine: b.endLine, lang: b.lang, size: b.lines.length })),
		codeMatches: bFindings,
		termUsages: cFindings,
	}, null, 2) + '\n', 'utf8');
	console.log(`\n  машинно-читаемый отчёт: ${rel(opts.json)}`);
}

section('ИТОГ');
console.log(`  код-блоков: ${blocks.length}`);
console.log(`  совпадений с референсами: ${bFindings.length}`);
console.log(`  употреблений чужих идентификаторов: ${cFindings.length}`);
process.exit(bFindings.length > 0 ? 1 : 0);
