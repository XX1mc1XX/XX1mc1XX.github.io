# -*- coding: utf-8 -*-
"""把 dist/articles.json 里的文章切块灌进 Cloudflare Vectorize。

切块口径和站内助手那边保持一致：按空行分段，再把相邻小段落合并到接近
CHUNK_CHARS，落单的超长段单独成块。中文按字符算就行——bge-m3 的多语言
向量不吃字节数的亏。

用法（在 blog 目录下）：
    set INGEST_TOKEN=xxx
    python tools/ingest.py

令牌就是 Pages 项目里那个 INGEST_TOKEN 环境变量的值。
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SITE = os.environ.get('SITE', 'https://xx1mc1xx.pages.dev')
CHUNK_CHARS = 900      # 一块大概这么多字
MIN_CHUNK_CHARS = 200  # 小于这个的往上一块并
MAX_PER_REQUEST = 60   # /api/ingest 一次最多 200，留点余量


def chunk_text(body, title):
    """按空行切段，合并到目标长度。返回 [(序号, 文本)]。"""
    paras = [p.strip() for p in body.split('\n\n')]
    paras = [p for p in paras if p]

    chunks = []
    buf = ''
    for p in paras:
        # 单段就超长（比如一张大代码块），自己独立成块
        if len(p) >= CHUNK_CHARS:
            if buf:
                chunks.append(buf)
                buf = ''
            chunks.append(p)
            continue

        if buf and len(buf) + len(p) + 2 > CHUNK_CHARS:
            chunks.append(buf)
            buf = p
        else:
            buf = f'{buf}\n\n{p}' if buf else p

    if buf:
        # 尾巴太短就并进上一块，避免出现「一段孤零零的标题」
        if chunks and len(buf) < MIN_CHUNK_CHARS:
            chunks[-1] = f'{chunks[-1]}\n\n{buf}'
        else:
            chunks.append(buf)

    return [(i, f'{title}\n\n{c}') for i, c in enumerate(chunks)]


def post_chunks(chunks, token, url):
    payload = json.dumps(
        {'chunks': [{'id': cid, 'title': title, 'url': url, 'text': text}
                    for cid, title, text in chunks]},
        ensure_ascii=False,
    ).encode('utf-8')

    req = urllib.request.Request(
        f'{SITE}/api/ingest',
        data=payload,
        method='POST',
        headers={'Content-Type': 'application/json; charset=utf-8',
                 'x-ingest-token': token},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    token = os.environ.get('INGEST_TOKEN')
    if not token:
        print('缺 INGEST_TOKEN 环境变量。')
        print('  PowerShell: $env:INGEST_TOKEN="xxx"; python tools/ingest.py')
        return 1

    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'dist', 'articles.json')
    if not os.path.exists(src):
        print(f'找不到 {src}，先跑一次 npm run build')
        return 1

    articles = json.loads(io.open(src, encoding='utf-8').read())
    only = sys.argv[1:]  # 传了参数就只灌这几篇

    total_ok = total_chunks = 0
    for art in articles:
        slug = art['id']
        if only and slug not in only:
            continue

        url = art.get('url') or f'/blog/{slug}/'
        chunks = chunk_text(art['body'], art['title'])
        # 打上文章标识，将来要单独删一篇时好定位
        flat = [(f'{slug}#{i}', art['title'], text) for i, text in chunks]

        try:
            ok = 0
            for s in range(0, len(flat), MAX_PER_REQUEST):
                res = post_chunks(flat[s:s + MAX_PER_REQUEST], token, url)
                ok += res.get('upserted', 0)
            print(f'{ok:>3} 块  {slug:<34} {art["title"]}')
            total_ok += ok
            total_chunks += len(flat)
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')[:200]
            print(f'失败  {slug}: HTTP {e.code} {body}')
            return 1
        except Exception as e:
            print(f'失败  {slug}: {e}')
            return 1

    print(f'\n共 {total_ok} 块（{total_chunks} 块切出来）灌进向量库。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
