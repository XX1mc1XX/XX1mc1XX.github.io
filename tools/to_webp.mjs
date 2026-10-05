// 把超大 PNG 转成 WebP，并改掉 markdown 里的引用。
//
// 起因：项目页的截图单页最高 2.3MB，而项目页正是 HR 最可能打开的那几页。
// PNG 是给界面截图用的最差格式——它按像素逐点无损存，一张 1600×900 的
// 界面截图轻松几百 KB，换成 WebP 通常只剩三成，肉眼看不出区别。
//
// 只动超过阈值的大图，小图保持原样（转了小几十 KB 的图，收益还不够一次额外请求）。
//
// 用法（blog 目录下）：
//     node tools/to_webp.mjs            # 预演，只报告
//     node tools/to_webp.mjs --write    # 真转 + 改 md 引用 + 删原 PNG
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGES = path.join(ROOT, 'public', 'images');
const CONTENT = path.join(ROOT, 'src', 'content');
// 低于这个体积的 PNG 不值得动
const MIN_BYTES = 100 * 1024;
const QUALITY = 85;

function walk(dir, visit) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, visit);
		else visit(full);
	}
}

function collect(ext) {
	const out = [];
	walk(IMAGES, (file) => {
		const base = path.basename(file);
		if (base.startsWith('_')) return; // 下划线开头的是本地预览图，不进仓库
		if (path.extname(file).toLowerCase() === ext) out.push(file);
	});
	return out;
}

const mdFiles = [];
walk(CONTENT, (file) => {
	if (file.endsWith('.md')) mdFiles.push(file);
});

function convert(bytes) {
	const kb = (n) => (n / 1024).toFixed(0).padStart(5);
	console.log(`\n大图转 WebP 前（${kb(MIN_BYTES)}KB 以上，共 ${bytes.length} 张）：`);
	bytes.forEach((b) => console.log(`  ${kb(b.size)}KB  ${b.rel}`));
}

const write = process.argv.includes('--write');

const candidates = collect('.png')
	.map((file) => ({ file, rel: path.relative(IMAGES, file).replace(/\\/g, '/'), size: fs.statSync(file).size }))
	.filter((item) => item.size >= MIN_BYTES);
convert(candidates);

// 只处理 markdown 里真的引用到的图。没被引用的多半是误放进来的，删了没意义
let refs = '';
const read = new Map();
for (const file of mdFiles) {
	const text = fs.readFileSync(file, 'utf8');
	read.set(file, text);
	refs += text;
}

const used = candidates.filter((item) => refs.includes(`/images/${item.rel}`));
const unused = candidates.filter((item) => !refs.includes(`/images/${item.rel}`));
if (unused.length) {
	console.log('\n没有 markdown 引用，跳过（不转也不删）：');
	unused.forEach((item) => console.log(`  ${item.rel}`));
}

console.log(`\n待转换 ${used.length} 张，原体积 ${(used.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(2)}MB`);
if (!write) {
	console.log('\n（预演，什么都没改。要真转加 --write）');
	process.exit(0);
}

let saved = 0;
const renamed = [];
for (const item of used) {
	const target = item.file.replace(/\.png$/i, '.webp');
	await sharp(item.file).webp({ quality: QUALITY, effort: 5 }).toFile(target);
	const after = fs.statSync(target).size;
	// 转了反而更大的（极少数：本来就是小的平涂图）就别要
	if (after >= item.size) {
		fs.unlinkSync(target);
		console.log(`  跳过（webp 没更小）  ${item.rel}  ${(item.size / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`);
		continue;
	}
	saved += item.size - after;
	renamed.push(item.rel);
	console.log(`  ${(item.size / 1024).toFixed(0).padStart(4)}KB → ${(after / 1024).toFixed(0).padStart(4)}KB  ${item.rel}`);
}

// 改引用。用 replaceAll 而不是正则：文件名里有中文和点号，正则容易误伤
let touched = 0;
for (const file of mdFiles) {
	const before = read.get(file);
	let after = before;
	for (const rel of renamed) {
		after = after.split(`/images/${rel}`).join(`/images/${rel.replace(/\.png$/i, '.webp')}`);
	}
	if (after !== before) {
		fs.writeFileSync(file, after);
		touched += 1;
	}
}

// 引用都改完了才删原图，顺序反了会留下断链
for (const rel of renamed) fs.unlinkSync(path.join(IMAGES, rel));

console.log(`\n转了 ${renamed.length} 张，省 ${(saved / 1024 / 1024).toFixed(2)}MB；改了 ${touched} 个 markdown 文件，原 PNG 已删除。`);
