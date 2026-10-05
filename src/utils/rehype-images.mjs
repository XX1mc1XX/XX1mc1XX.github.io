// 构建时给 markdown 里的每张图补上 intrinsic 尺寸和 loading="lazy"。
//
// 尺寸不是可有可无的：缺了它，图加载完会把下面的正文顶下去。正文正读着
// 突然跳一下，比慢一点更烦人。这些图都在 public/ 里，Astro 的图片优化
// 只认 src/assets，够不着它们，所以自己读文件头拿宽高。
//
// 拿不到尺寸（外链、文件不在）就只加 lazy，不填宽高——宁可不填，也不能填错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

function pngSize(buf) {
	if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
	if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'GIF') return null;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpSize(buf) {
	if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
	const kind = buf.toString('latin1', 12, 16);
	if (kind === 'VP8 ') {
		return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
	}
	if (kind === 'VP8L') {
		const bits = buf.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (kind === 'VP8X') {
		return {
			width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
			height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
		};
	}
	return null;
}

function jpegSize(buf) {
	let i = 2;
	while (i < buf.length - 9) {
		if (buf[i] !== 0xff) {
			i += 1;
			continue;
		}
		const marker = buf[i + 1];
		// SOF0..SOF15，其中 c4/c8/cc 不是尺寸段
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + buf.readUInt16BE(i + 2);
	}
	return null;
}

// SVG 没有固定像素尺寸。有 width/height 就用，没有就拿 viewBox 当宽高比——
// 比例对了就不会抖，绝对像素多少无关紧要
function svgSize(text) {
	const tag = text.match(/<svg[^>]*>/i)?.[0];
	if (!tag) return null;
	const w = tag.match(/\bwidth=["']?(\d+)/i);
	const h = tag.match(/\bheight=["']?(\d+)/i);
	if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
	const viewBox = tag.match(/viewBox=["']([\d.\s,-]+)["']/i);
	if (viewBox) {
		const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
		if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
			return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
		}
	}
	return null;
}

const cache = new Map();

function measure(src) {
	if (cache.has(src)) return cache.get(src);
	let size = null;
	// 只认本站 public 里的图；外链、data: 之类读不到文件，直接算没有
	if (src.startsWith('/')) {
		try {
			// hast 里的 src 是 URL 编码过的——中文文件名会变成 %E9%A1%B9...，
			// 不还原的话 path.join 出来是个不存在的路径，尺寸永远读不到
			const file = path.join(PUBLIC_DIR, decodeURIComponent(src).slice(1));
			const buf = fs.readFileSync(file);
			const ext = path.extname(file).toLowerCase();
			if (ext === '.svg') size = svgSize(buf.toString('utf8'));
			else if (ext === '.png') size = pngSize(buf);
			else if (ext === '.webp') size = webpSize(buf);
			else if (ext === '.gif') size = gifSize(buf);
			else if (ext === '.jpg' || ext === '.jpeg') size = jpegSize(buf);
		} catch {
			size = null;
		}
	}
	cache.set(src, size);
	return size;
}

function visit(node) {
	if (!node || typeof node !== 'object') return;

	if (node.type === 'element' && node.tagName === 'img') {
		const props = (node.properties ??= {});
		props.loading = 'lazy';
		props.decoding = 'async';

		// 作者自己写了宽高就别覆盖
		const size = measure(String(props.src ?? ''));
		if (size && props.width === undefined) {
			props.width = size.width;
			props.height = size.height;
		}
	}

	for (const child of node.children ?? []) visit(child);
}

export default function rehypeImages() {
	return (tree) => visit(tree);
}
