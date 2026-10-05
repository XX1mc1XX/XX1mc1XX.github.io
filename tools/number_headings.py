# -*- coding: utf-8 -*-
"""给文章正文的标题加层级编号：## 用「一、二、三」，### 用「1. 2. 3.」。

- 跳过 frontmatter 与代码块（代码里的 # 注释不能被改）
- 幂等：已经带编号的标题不会重复加
- --dry 只看结果不落盘

用法（blog 目录下）：
    python tools/number_headings.py --dry
    python tools/number_headings.py
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, 'src', 'content', 'posts')

CN = '零一二三四五六七八九'


def to_cn(n):
    """1 -> 一，11 -> 十一，21 -> 二十一"""
    if n < 10:
        return CN[n]
    if n < 20:
        return '十' + (CN[n % 10] if n % 10 else '')
    return CN[n // 10] + '十' + (CN[n % 10] if n % 10 else '')


# 已经带编号的样子：一、 / 1. / 1、 / （一）
ALREADY = re.compile(r'^\s*(?:[一二三四五六七八九十]+[、.]|\d+[.、]|\d+\)|（[一二三四五六七八九十]+）)')
# 用来剥掉标题开头的编号，剥完重新编，保证幂等
STRIP_NUM = re.compile(
    r'^(?:[一二三四五六七八九十]+[、.]|\d+[.、]|\d+\)|（[一二三四五六七八九十]+）)\s*')

# 模板化的收尾章节不编号：它们不是内容章节，编上号会读成「十一、结尾」。
# 不编号也不占号，所以正文主体的序号是连续的
TAIL = re.compile(r'^(我踩过的坑|踩过的坑|结尾|小结|后记|写在最后|结语)$')


def number_body(body):
    """返回 (新正文, 改动数)。"""
    out, changed = [], 0
    h2 = 0
    h3 = 0
    in_fence = False
    for line in body.split('\n'):
        stripped = line.strip()

        # 代码围栏：进出一律不管内容
        if stripped.startswith('```') or stripped.startswith('~~~'):
            in_fence = not in_fence
            out.append(line)
            continue

        if in_fence:
            out.append(line)
            continue

        m2 = re.match(r'^##\s+(.*)$', line)
        if m2 and not line.startswith('###'):
            title = m2.group(1).strip()
            if TAIL.match(title) or ALREADY.match(title):
                h3 = 0
                out.append(line)
                continue
            h2 += 1
            h3 = 0  # 每换一个二级标题，三级编号重新从 1 开始
            out.append(f'## {to_cn(h2)}、{title}')
            changed += 1
            continue

        m3 = re.match(r'^###\s+(.*)$', line)
        if m3:
            # 三级标题一律重编成「1. 2. 3.」：有几篇原本自带「一、二、三」，
            # 不剥掉的话同一篇文章里二级用中文、三级也用中文，层级就分不出来了
            title = STRIP_NUM.sub('', m3.group(1).strip()).strip()
            if TAIL.match(title):
                out.append(line)
                continue
            h3 += 1
            numbered = f'### {h3}. {title}'
            # 内容没变就不算改动，否则重复跑会谎报一堆「改动」
            if numbered == line:
                out.append(line)
            else:
                out.append(numbered)
                changed += 1
            continue

        out.append(line)

    return '\n'.join(out), changed


def main():
    dry = '--dry' in sys.argv
    files = sorted(f for f in os.listdir(POSTS) if f.endswith('.md'))
    total = 0
    for fn in files:
        path = os.path.join(POSTS, fn)
        # utf-8-sig：有几篇文件带 BOM，用 utf-8 读会让 startswith('---') 落空，
        # 整篇被静默跳过。读的时候顺手把 BOM 吃掉，写回就不再带它
        text = io.open(path, encoding='utf-8-sig').read()

        if not text.startswith('---'):
            print(f'  !!  {fn:<42} 没有 frontmatter，跳过')
            continue
        end = text.index('\n---', 3)
        fm, body = text[:end + 4], text[end + 4:]

        new_body, changed = number_body(body)
        if changed == 0:
            print(f'  --  {fn:<42} 无改动')
            continue

        total += changed
        print(f'  {changed:>3} 处  {fn}')
        if dry:
            # 只打前几个标题，看看编号长什么样
            shown = 0
            for line in new_body.split('\n'):
                if line.startswith('## ') or line.startswith('### '):
                    print('        ' + line[:66])
                    shown += 1
                    if shown >= 4:
                        break
        else:
            io.open(path, 'w', encoding='utf-8', newline='').write(fm + new_body)

    print(f'\n共 {total} 个标题{"（dry run，未写入）" if dry else " 已加编号"}。')


if __name__ == '__main__':
    sys.exit(main())
